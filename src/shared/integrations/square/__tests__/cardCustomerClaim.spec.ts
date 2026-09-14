import { beforeEach,describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({rpc:vi.fn(),ensure:vi.fn(),find:vi.fn(),verify:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/shared/lib/supabase/serviceRole",()=>({createServiceRoleClient:()=>({rpc:mocks.rpc})}));
vi.mock("../client",()=>({ensureSquareCustomer:mocks.ensure,findSquareCustomerByReference:mocks.find,verifySquareCardCustomerIdentity:mocks.verify}));
import { resolveSquareCardCustomer } from "../cardCustomerClaim";
import { cardFailure } from "../../payments/cardDeliveryFailure";
import type { SquareConfig } from "../client";
const operation={operationId:"55630000-0000-4000-8000-000000000301",attemptToken:"55630000-0000-4000-8000-000000000302"};
const claimId="55630000-0000-4000-8000-000000000303";
const leaseToken="55630000-0000-4000-8000-000000000304";
const cfg={salonId:"55630000-0000-4000-8000-000000000001",merchantId:"merchant-1",environment:"sandbox"} as SquareConfig;
function claimed(allowCreate=true) {return {ok:true,code:"claimed_v2",identity_version:2,reference_authorized:true,operation_id:operation.operationId,booking_id:"55630000-0000-4000-8000-000000000305",lookup_mode:"verified_phone",previously_dispatched:!allowCreate,expected_customer_id:null,claim_id:claimId,lease_token:leaseToken,allow_create:allowCreate,
  salon_id:cfg.salonId,merchant_id:cfg.merchantId,environment:cfg.environment,reference_id:`nq-customer:${claimId}`,idempotency_key:`sqcu:${claimId}`,
  request_material:{client_name:"Synthetic Frozen",client_phone:"+16045550199",client_email:"frozen@example.test"}};}
const result=(data:unknown)=>({data,error:null});
beforeEach(()=>{vi.resetAllMocks();});
describe("durable Square customer claim coordinator",()=>{
  it("dispatches only after the customer lease is prepared and uses frozen material",async()=>{
    mocks.rpc.mockResolvedValueOnce(result(claimed())).mockResolvedValueOnce(result({ok:true}))
      .mockResolvedValueOnce(result({ok:true,code:"known",customer_id:"customer-1"}));
    mocks.ensure.mockImplementationOnce(async(_cfg,opts)=>{await opts.beforeCreate();return "customer-1";});
    await expect(resolveSquareCardCustomer(cfg,operation)).resolves.toBe("customer-1");
    expect(mocks.ensure).toHaveBeenCalledWith(cfg,expect.objectContaining({name:"Synthetic Frozen",phone:"+16045550199",
      email:"frozen@example.test",lookupPolicy:"verified_phone",previouslyDispatched:false,referenceId:`nq-customer:${claimId}`,idempotencyKey:`sqcu:${claimId}`}));
    expect(mocks.rpc.mock.calls.map(call=>call[0])).toEqual(["claim_square_card_customer","prepare_square_card_customer","complete_square_card_customer"]);
  });
  it("returns known bound identity with no provider mutation or search",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(),code:"known",customer_id:"customer-1",expected_customer_id:"customer-1"}));
    await expect(resolveSquareCardCustomer(cfg,operation)).resolves.toBe("customer-1");
    expect(mocks.ensure).not.toHaveBeenCalled();expect(mocks.find).not.toHaveBeenCalled();
  });
  it("leaves a waiting follower safely retryable without a provider call",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({ok:false,code:"customer_wait"}));
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{retryability:"safe_retry"}});
    expect(mocks.ensure).not.toHaveBeenCalled();expect(mocks.find).not.toHaveBeenCalled();
  });
  it("reconciles unknown creation by shared reference without replaying CreateCustomer",async()=>{
    mocks.rpc.mockResolvedValueOnce(result(claimed(false))).mockResolvedValueOnce(result({ok:true,code:"known",customer_id:"customer-1"}));
    mocks.find.mockResolvedValueOnce("customer-1");
    await expect(resolveSquareCardCustomer(cfg,operation)).resolves.toBe("customer-1");
    expect(mocks.ensure).not.toHaveBeenCalled();expect(mocks.find).toHaveBeenCalledWith(cfg,`nq-customer:${claimId}`);
  });
  it("records empty unknown reads without authorizing creation in the same request",async()=>{
    mocks.rpc.mockResolvedValueOnce(result(claimed(false))).mockResolvedValueOnce(result({ok:true,code:"ready"}));
    mocks.find.mockResolvedValueOnce(null);
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{retryability:"safe_retry"}});
    expect(mocks.ensure).not.toHaveBeenCalled();expect(mocks.rpc.mock.calls[1][1]).toMatchObject({p_outcome:"not_found"});
  });
  it("keeps customer response loss unknown and does not log raw provider errors",async()=>{
    mocks.rpc.mockResolvedValueOnce(result(claimed())).mockResolvedValueOnce(result({ok:true})).mockResolvedValueOnce(result({ok:true}));
    mocks.ensure.mockImplementationOnce(async(_cfg,opts)=>{await opts.beforeCreate();throw cardFailure("customer_create","square_customer_create_failed","reconcile_first");});
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{stage:"customer_create",retryability:"reconcile_first"}});
    expect(mocks.rpc.mock.calls[2][1]).toMatchObject({p_outcome:"unknown"});
  });
  it("never dispatches after lost preparation acknowledgment",async()=>{
    mocks.rpc.mockResolvedValueOnce(result(claimed())).mockRejectedValueOnce(new Error("PRIVATE_DATABASE_DETAIL")).mockResolvedValueOnce(result({ok:true}));
    let dispatched=false;
    mocks.ensure.mockImplementationOnce(async(_cfg,opts)=>{await opts.beforeCreate();dispatched=true;return "customer-1";});
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{stage:"dispatch_preparation",retryability:"safe_retry"}});
    expect(dispatched).toBe(false);expect(mocks.rpc.mock.calls[2][1]).toMatchObject({p_outcome:"not_dispatched"});
  });
  it.each(["salon_id","merchant_id","environment"])("rejects a mismatched %s before provider work",async(field)=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(),[field]:"other"}));
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{stage:"configuration"}});
    expect(mocks.ensure).not.toHaveBeenCalled();expect(mocks.find).not.toHaveBeenCalled();
  });
});


describe("Square customer ownership and legacy compatibility",()=>{
  it.each([
    {identity_version:undefined}, {identity_version:1}, {reference_authorized:undefined}, {reference_authorized:false}, {operation_id:claimId},
    {booking_id:"not-a-booking"}, {lookup_mode:"email"}, {previously_dispatched:"false"},
  ])("rejects malformed durable authority before accepting a known ID: %j",async(overrides)=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(),code:"known",customer_id:"customer-1",expected_customer_id:"customer-1",...overrides}));
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{retryability:"safe_retry"}});
    expect(mocks.ensure).not.toHaveBeenCalled();expect(mocks.find).not.toHaveBeenCalled();expect(mocks.verify).not.toHaveBeenCalled();
  });
  it("does not treat a legacy known contact as a v2 cached identity",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(),code:"known",lookup_mode:"legacy_reference",customer_id:"customer-1"}));
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{retryability:"safe_retry"}});
    expect(mocks.ensure).not.toHaveBeenCalled();expect(mocks.find).not.toHaveBeenCalled();
  });
  it("uses booking-scoped discovery even when malformed upstream material includes unproved contact",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(),lookup_mode:"booking_reference"}))
      .mockResolvedValueOnce(result({ok:true,code:"known",customer_id:"own-customer"}));
    mocks.ensure.mockResolvedValueOnce("own-customer");
    await expect(resolveSquareCardCustomer(cfg,operation)).resolves.toBe("own-customer");
    expect(mocks.ensure).toHaveBeenCalledWith(cfg,expect.objectContaining({lookupPolicy:"reference_only",previouslyDispatched:false}));
  });
  it("preserves a previous dispatch fence after empty-read exhaustion",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(),previously_dispatched:true}))
      .mockResolvedValueOnce(result({ok:true,code:"known",customer_id:"original-customer"}));
    mocks.ensure.mockResolvedValueOnce("original-customer");
    await expect(resolveSquareCardCustomer(cfg,operation)).resolves.toBe("original-customer");
    expect(mocks.ensure).toHaveBeenCalledWith(cfg,expect.objectContaining({previouslyDispatched:true,referenceId:`nq-customer:${claimId}`,idempotencyKey:`sqcu:${claimId}`}));
  });
  it.each(["legacy_reference","legacy_phone"])("checks exact legacy known identity without provider mutation: %s",async(lookupMode)=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(false),code:"verify_known",lookup_mode:lookupMode,expected_customer_id:"legacy-customer"}))
      .mockResolvedValueOnce(result({ok:true,code:"known",customer_id:"legacy-customer"}));
    mocks.verify.mockResolvedValueOnce(true);
    await expect(resolveSquareCardCustomer(cfg,operation)).resolves.toBe("legacy-customer");
    expect(mocks.verify).toHaveBeenCalledWith(cfg,lookupMode === "legacy_phone"
      ? {customerId:"legacy-customer",verifiedPhone:"+16045550199"}
      : {customerId:"legacy-customer",referenceId:`nq-customer:${claimId}`});
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({p_outcome:"found",p_customer_id:"legacy-customer"});
  });
  it.each([
    [{ok:true,code:"identity_retry_required"},"safe_retry"],
    [{ok:true,code:"identity_review_required"},"manual_review"],
    [{ok:false,code:"identity_retry_required"},"manual_review"],
  ])("requires acknowledged terminal-safe identity recovery: %j",async(completion,retryability)=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(false),code:"verify_known",lookup_mode:"legacy_reference",expected_customer_id:"legacy-customer"}))
      .mockResolvedValueOnce(result(completion));mocks.verify.mockResolvedValueOnce(false);
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{code:"square_customer_identity_unverified",retryability}});
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({p_outcome:"identity_not_authorized",p_customer_id:null});
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("does not turn failed legacy read into negative identity proof",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(false),code:"verify_known",lookup_mode:"legacy_phone",expected_customer_id:"legacy-customer"}))
      .mockResolvedValueOnce(result({ok:true}));
    mocks.verify.mockRejectedValueOnce(cardFailure("customer_search","square_customer_search_failed","safe_retry"));
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{retryability:"safe_retry"}});
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({p_outcome:"read_failed"});
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("checks phone ownership on a legacy unknown reference match before completion",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(false),lookup_mode:"legacy_phone"}))
      .mockResolvedValueOnce(result({ok:true,code:"identity_review_required"}));
    mocks.find.mockResolvedValueOnce("wrong-phone-customer");mocks.verify.mockResolvedValueOnce(false);
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{retryability:"manual_review"}});
    expect(mocks.verify).toHaveBeenCalledWith(cfg,{customerId:"wrong-phone-customer",verifiedPhone:"+16045550199"});
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({p_outcome:"identity_not_authorized"});
  });
  it("keeps lost identity rejection acknowledgment uncertain",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(false),code:"verify_known",lookup_mode:"legacy_reference",expected_customer_id:"legacy-customer"}))
      .mockRejectedValueOnce(new Error("PRIVATE_DB_DETAIL"));mocks.verify.mockResolvedValueOnce(false);
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{stage:"database_completion",retryability:"reconcile_first"}});
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
});


describe("legacy exhaustion preserves the original request",()=>{
  it.each(["legacy_reference","legacy_phone"])("permits only the original frozen body/key after SQL exhaustion: %s",async(mode)=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(),lookup_mode:mode,previously_dispatched:true}))
      .mockResolvedValueOnce(result({ok:true,code:"known",customer_id:"original-customer"}));
    mocks.ensure.mockResolvedValueOnce("original-customer");mocks.verify.mockResolvedValueOnce(true);
    await expect(resolveSquareCardCustomer(cfg,operation)).resolves.toBe("original-customer");
    expect(mocks.ensure).toHaveBeenCalledWith(cfg,expect.objectContaining({lookupPolicy:"reference_only",previouslyDispatched:true,
      referenceId:`nq-customer:${claimId}`,idempotencyKey:`sqcu:${claimId}`,phone:"+16045550199",email:"frozen@example.test"}));
    if(mode === "legacy_phone") expect(mocks.verify).toHaveBeenCalledWith(cfg,{customerId:"original-customer",verifiedPhone:"+16045550199"});
    else expect(mocks.verify).not.toHaveBeenCalled();
  });
  it.each(["legacy_reference","legacy_phone"])("refuses fresh legacy creation without an original dispatch fence: %s",async(mode)=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(),lookup_mode:mode,previously_dispatched:false}));
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{retryability:"safe_retry"}});
    expect(mocks.ensure).not.toHaveBeenCalled();expect(mocks.find).not.toHaveBeenCalled();
  });
});


describe("customer mutation delivery truth",()=>{
  it("retains reconcile-first after a post-create ownership read timeout",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(),lookup_mode:"legacy_phone",previously_dispatched:true}))
      .mockResolvedValueOnce(result({ok:true})).mockResolvedValueOnce(result({ok:true}));
    mocks.ensure.mockImplementationOnce(async(_cfg,opts)=>{await opts.beforeCreate();return "created-customer";});
    mocks.verify.mockRejectedValueOnce(cardFailure("customer_search","square_customer_search_failed","safe_retry",503));
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{stage:"customer_search",httpStatus:503,retryability:"reconcile_first"}});
    expect(mocks.rpc.mock.calls[2][1]).toMatchObject({p_outcome:"unknown"});
  });
  it.each([null,undefined,"another-customer"])("refuses a mismatched cached customer binding: %s",async(expectedId)=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(),code:"known",customer_id:"customer-1",expected_customer_id:expectedId}));
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{retryability:"safe_retry"}});
    expect(mocks.ensure).not.toHaveBeenCalled();expect(mocks.find).not.toHaveBeenCalled();expect(mocks.verify).not.toHaveBeenCalled();
  });
});


describe("previously attached foreign legacy claim",()=>{
  it("reads its original reference but never authorizes a foreign unverified identity",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(false),lookup_mode:"legacy_reference",reference_authorized:false}))
      .mockResolvedValueOnce(result({ok:true,code:"identity_retry_required"}));
    mocks.find.mockResolvedValueOnce("foreign-customer");
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{code:"square_customer_identity_unverified",retryability:"safe_retry"}});
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({p_outcome:"identity_not_authorized",p_customer_id:null});
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("a failed foreign reference read remains a read failure",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(false),lookup_mode:"legacy_reference",reference_authorized:false}))
      .mockResolvedValueOnce(result({ok:true}));
    mocks.find.mockRejectedValueOnce(cardFailure("customer_search","square_customer_search_failed","safe_retry"));
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{retryability:"safe_retry"}});
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({p_outcome:"read_failed"});
  });
  it("keeps zero matches in the existing successful-empty-read policy",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(false),lookup_mode:"legacy_reference",reference_authorized:false}))
      .mockResolvedValueOnce(result({ok:true,code:"customer_wait"}));
    mocks.find.mockResolvedValueOnce(null);
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{retryability:"safe_retry"}});
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({p_outcome:"not_found"});expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("refuses a malformed creation grant for an unauthorized reference",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(),lookup_mode:"legacy_reference",previously_dispatched:true,reference_authorized:false}));
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{retryability:"safe_retry"}});
    expect(mocks.ensure).not.toHaveBeenCalled();expect(mocks.find).not.toHaveBeenCalled();
  });
});


describe("foreign zero-match terminal outcome",()=>{
  it.each([
    ["identity_review_required","manual_review"],
    ["identity_retry_required","safe_retry"],
  ])("honors the DB terminal recovery outcome %s",async(code,retryability)=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(false),lookup_mode:"legacy_reference",reference_authorized:false}))
      .mockResolvedValueOnce(result({ok:true,code}));mocks.find.mockResolvedValueOnce(null);
    await expect(resolveSquareCardCustomer(cfg,operation)).rejects.toMatchObject({failure:{retryability}});
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({p_outcome:"not_found"});expect(mocks.ensure).not.toHaveBeenCalled();
  });
});
