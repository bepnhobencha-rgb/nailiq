import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
const h=vi.hoisted(()=>({rpc:vi.fn(),resolve:vi.fn(),remove:vi.fn()}));
vi.mock("@/shared/lib/supabase/serviceRole",()=>({createServiceRoleClient:()=>({rpc:h.rpc})}));
vi.mock("@/shared/integrations/payments",()=>({resolvePaymentProvider:h.resolve}));
vi.mock("@/shared/booking/reconcileBookingCardRemoval",()=>({reconcileBookingCardRemoval:vi.fn()}));
import { removeCardWithManagementCapability } from "../bookingCardManagement";
import { RemovalDeliveryError, removalFailure, removalFailureRpc } from "@/shared/integrations/payments/removalDeliveryFailure";
import { CardDeliveryError } from "@/shared/integrations/payments/cardDeliveryFailure";
const id="11111111-1111-4111-8111-111111111111",attempt="22222222-2222-4222-8222-222222222222";
const input={tokenId:id,requestId:attempt,expectedCardFingerprint:"a".repeat(64)};
const claim={ok:true,code:"claimed",operation_id:id,attempt_token:attempt,provider_idempotency_key:id,salon_id:id,provider_material:{card_id:"synthetic_card",customer_id:"synthetic_customer"}};
const diagnostics=()=>h.rpc.mock.calls.filter(c=>c[0]==="record_booking_card_removal_delivery_failure").map(c=>c[1]);
const completions=()=>h.rpc.mock.calls.filter(c=>c[0]==="complete_booking_card_management_operation").map(c=>c[1]);
beforeEach(()=>{vi.clearAllMocks();h.resolve.mockResolvedValue({kind:"square",removeSavedCard:h.remove});
 h.rpc.mockImplementation(async(name:string)=>({error:null,data:name==="claim_booking_card_management_operation"?claim:name==="prepare_booking_card_removal_dispatch"?{ok:true,code:"removal_dispatch_prepared"}:name==="complete_booking_card_management_operation"?{ok:false,code:"remove_unknown"}:{ok:true}}));
 h.remove.mockImplementation(async({beforeRemovalDispatch})=>{await beforeRemovalDispatch({provider:"square",merchantId:"merchant",environment:"sandbox"});throw new RemovalDeliveryError("removal_provider_write_failed");});
});
describe("initial removal diagnostic truth",()=>{
 it("records configuration read failure without provider work or closing sending claim",async()=>{
  h.resolve.mockRejectedValue(new Error("secret email@example.com"));expect((await removeCardWithManagementCapability(input)).code).toBe("card_management_unavailable");
  expect(h.remove).not.toHaveBeenCalled();expect(completions()).toEqual([]);expect(diagnostics()[0]).toMatchObject({p_code:"removal_configuration_unavailable",p_provider:null,p_mutation_status:"not_requested"});
 });
 it("records unconfigured provider and retains failed completion policy",async()=>{h.resolve.mockResolvedValue(null);await removeCardWithManagementCapability(input);expect(completions()[0]).toMatchObject({p_outcome:"failed",p_error_code:"removal_configuration_invalid"});});
 it("preparation loss records not requested and leaves same operation sending",async()=>{
  h.rpc.mockImplementation(async(name:string)=>({data:name==="claim_booking_card_management_operation"?claim:null,error:null}));
  await removeCardWithManagementCapability(input);expect(diagnostics()[0].p_code).toBe("removal_dispatch_unavailable");expect(completions()).toEqual([]);
 });
 it.each(["removal_preflight_failed","removal_preflight_invalid","removal_provider_write_failed","removal_invalid_provider_receipt"] as const)("preserves %s without returning diagnostics to customer",async code=>{
  h.remove.mockRejectedValue(new RemovalDeliveryError(code));const result=await removeCardWithManagementCapability(input);
  expect(completions()[0]).toMatchObject({p_outcome:"unknown",p_error_code:code});expect(diagnostics()[0].p_code).toBe(code);expect(result.code).toBe("remove_unknown");expect(JSON.stringify(result)).not.toContain(code);
 });
 it("unknown adapter error is explicitly unclassified without message or stack",async()=>{h.remove.mockRejectedValue(new Error("PAN secret 123 email@example.com"));await removeCardWithManagementCapability(input);expect(diagnostics()[0].p_code).toBe("removal_provider_unclassified");expect(JSON.stringify(diagnostics())).not.toMatch(/secret|email@/);});
 it("missing provider acknowledgment keeps unknown and records receipt stage",async()=>{h.remove.mockResolvedValue({providerReference:""});await removeCardWithManagementCapability(input);expect(diagnostics()[0].p_stage).toBe("receipt_validation");});
 it.each(["error","throw","reject"])("distinguishes DB completion %s from provider error",async mode=>{
  h.remove.mockImplementation(async({beforeRemovalDispatch})=>{await beforeRemovalDispatch({provider:"square",merchantId:"merchant",environment:"sandbox"});return {providerReference:"synthetic_card"};});
  const impl=h.rpc.getMockImplementation()!;h.rpc.mockImplementation(async(name:string,...args:unknown[])=>{if(name==="complete_booking_card_management_operation"){if(mode==="throw")throw Error("database secret");return mode==="error"?{data:null,error:{message:"secret"}}:{data:{ok:false,code:"completion_conflict"},error:null};}return impl(name,...args);});
  await removeCardWithManagementCapability(input);expect(h.remove).toHaveBeenCalledTimes(1);expect(diagnostics()[0].p_code).toBe(mode==="reject"?"removal_completion_rejected":"removal_completion_uncertain");
 });
 it("diagnostic DB failure never redispatches or changes the primary outcome",async()=>{const impl=h.rpc.getMockImplementation()!;h.rpc.mockImplementation(async(name:string,...args:unknown[])=>{if(name==="record_booking_card_removal_delivery_failure")throw Error("secret");return impl(name,...args);});expect((await removeCardWithManagementCapability(input)).code).toBe("remove_unknown");expect(h.remove).toHaveBeenCalledTimes(1);});
 it("filters hostile metadata even inside typed errors",()=>{
  const err=new CardDeliveryError({stage:"configuration",code:"raw secret",httpStatus:503,squareCodes:["SERVICE_UNAVAILABLE","secret"],squareCategories:["API_ERROR","email@example.com"],retryability:"safe_retry"});
  const f=removalFailure(new RemovalDeliveryError("removal_provider_write_failed",err,"read_failed"),"removal_provider_unclassified");
  expect(removalFailureRpc(f,"square")).toMatchObject({p_http_status:503,p_square_codes:["SERVICE_UNAVAILABLE"],p_square_categories:["API_ERROR"],p_retryability:"reconcile_first",p_reconciliation_outcome:"read_failed"});
  expect(JSON.stringify(removalFailureRpc(f,"stripe"))).not.toMatch(/SERVICE_UNAVAILABLE|API_ERROR|503/);
 });
});
