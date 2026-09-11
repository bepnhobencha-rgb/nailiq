import { beforeEach,describe,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({rpc:vi.fn(),ensure:vi.fn(),find:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/shared/lib/supabase/serviceRole",()=>({createServiceRoleClient:()=>({rpc:mocks.rpc})}));
vi.mock("../client",()=>({ensureSquareCustomer:mocks.ensure,findSquareCustomerByReference:mocks.find}));
import { resolveSquareCardCustomer } from "../cardCustomerClaim";
import { cardFailure } from "../../payments/cardDeliveryFailure";
import type { SquareConfig } from "../client";
const operation={operationId:"55630000-0000-4000-8000-000000000301",attemptToken:"55630000-0000-4000-8000-000000000302"};
const claimId="55630000-0000-4000-8000-000000000303";
const leaseToken="55630000-0000-4000-8000-000000000304";
const cfg={salonId:"55630000-0000-4000-8000-000000000001",merchantId:"merchant-1",environment:"sandbox"} as SquareConfig;
function claimed(allowCreate=true) {return {ok:true,code:"claimed",claim_id:claimId,lease_token:leaseToken,allow_create:allowCreate,
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
      email:"frozen@example.test",referenceId:`nq-customer:${claimId}`,idempotencyKey:`sqcu:${claimId}`}));
    expect(mocks.rpc.mock.calls.map(call=>call[0])).toEqual(["claim_square_card_customer","prepare_square_card_customer","complete_square_card_customer"]);
  });
  it("returns known bound identity with no provider mutation or search",async()=>{
    mocks.rpc.mockResolvedValueOnce(result({...claimed(),code:"known",customer_id:"customer-1"}));
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
