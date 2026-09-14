import {beforeEach,describe,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({rpc:vi.fn(),config:vi.fn(),read:vi.fn()}));
vi.mock("server-only",()=>({}));vi.mock("@/shared/lib/supabase/serviceRole",()=>({createServiceRoleClient:()=>({rpc:m.rpc})}));
vi.mock("@/shared/integrations/square/looseDb",()=>({looseServiceClient:()=>({})}));
vi.mock("@/shared/integrations/square/client",()=>({getSquareConfig:m.config,readSquareCardStateById:m.read}));
import {reconcileOwnerBookingCardRemoval} from "../reconcileBookingCardRemoval";
const salon="11111111-1111-4111-8111-111111111111",op="22222222-2222-4222-8222-222222222222",actor="33333333-3333-4333-8333-333333333333";
const input={salonId:salon,operationId:op,actorId:actor};const args={p_salon_id:salon,p_operation_id:op,p_actor_id:actor};
const ctx={ok:true,code:"recovery_read_required",operation_id:op,salon_id:salon,source_removal_binding_id:op,source_save_operation_id:null,card_id:"ccof:synthetic",customer_id:"qa_customer",merchant_id:"qa_merchant",environment:"sandbox"};
const card={cardId:ctx.card_id,customerId:ctx.customer_id,merchantId:ctx.merchant_id,enabled:false,brand:"VISA",last4:"1111"};
beforeEach(()=>{vi.resetAllMocks();m.rpc.mockResolvedValueOnce({data:ctx}).mockResolvedValue({data:{ok:true,code:"removed",idempotent:false}});m.config.mockResolvedValue({salonId:salon,merchantId:ctx.merchant_id,environment:"sandbox"});m.read.mockResolvedValue(card);});
describe("owner read-only removal recovery",()=>{
 it("uses owner-authorized context and completion, never customer renewal",async()=>{
  expect((await reconcileOwnerBookingCardRemoval(input)).ok).toBe(true);
  expect(m.rpc).toHaveBeenNthCalledWith(1,"prepare_owner_booking_card_removal_recovery",args);
  expect(m.rpc).toHaveBeenLastCalledWith("complete_owner_booking_card_removal_recovery",expect.objectContaining({...args,p_receipt:expect.objectContaining({enabled:false,operation_id:op})}));expect(m.read).toHaveBeenCalledTimes(1);
 });
 it.each(["unauthorized","expired_or_revoked","booking_state_changed"])("%s blocks before provider read",async code=>{
  m.rpc.mockReset().mockResolvedValueOnce({data:{ok:false,code}});expect((await reconcileOwnerBookingCardRemoval(input)).ok).toBe(false);expect(m.config).not.toHaveBeenCalled();expect(m.read).not.toHaveBeenCalled();
 });
 it.each([{salon_id:actor},{operation_id:actor,source_removal_binding_id:actor}])("mismatched bound result %j blocks provider",async change=>{
  m.rpc.mockReset().mockResolvedValueOnce({data:{...ctx,...change}});expect((await reconcileOwnerBookingCardRemoval(input)).ok).toBe(false);expect(m.read).not.toHaveBeenCalled();
 });
 it("changed provider account blocks read",async()=>{m.config.mockResolvedValue({salonId:salon,merchantId:"other",environment:"sandbox"});expect((await reconcileOwnerBookingCardRemoval(input)).ok).toBe(false);expect(m.read).not.toHaveBeenCalled();});
 it("active card never reaches completion",async()=>{m.read.mockResolvedValue({...card,enabled:true});expect((await reconcileOwnerBookingCardRemoval(input)).ok).toBe(false);expect(m.rpc.mock.calls.some(c=>c[0]==="complete_owner_booking_card_removal_recovery")).toBe(false);});
 it("read failure records under owner-scoped RPC",async()=>{m.read.mockRejectedValue(new Error("synthetic timeout"));expect((await reconcileOwnerBookingCardRemoval(input)).ok).toBe(false);expect(m.rpc).toHaveBeenLastCalledWith("record_owner_booking_card_removal_recovery_outcome",expect.objectContaining({...args,p_code:"reconciliation_read_failed"}));});
 it("membership/state changed at completion cannot return success",async()=>{m.rpc.mockReset().mockResolvedValueOnce({data:ctx}).mockResolvedValueOnce({data:{ok:false,code:"unauthorized"}});expect((await reconcileOwnerBookingCardRemoval(input)).ok).toBe(false);expect(m.read).toHaveBeenCalledTimes(1);});
 it("completion response loss never repeats provider work",async()=>{m.rpc.mockReset().mockResolvedValueOnce({data:ctx}).mockRejectedValueOnce(new Error("DB loss"));expect((await reconcileOwnerBookingCardRemoval(input)).code).toBe("completion_write_uncertain");expect(m.read).toHaveBeenCalledTimes(1);});
 it("receipt replay is provider-free",async()=>{m.rpc.mockReset().mockResolvedValue({data:{ok:true,code:"removed",idempotent:true}});expect((await reconcileOwnerBookingCardRemoval(input)).ok).toBe(true);expect(m.read).not.toHaveBeenCalled();});
 it("invalid actor is rejected before DB",async()=>{expect((await reconcileOwnerBookingCardRemoval({...input,actorId:"bad"})).code).toBe("invalid_request");expect(m.rpc).not.toHaveBeenCalled();});
});

it("recent Owner preparation returns pending without provider work or failure diagnostics",async()=>{
 m.rpc.mockReset().mockResolvedValue({data:{ok:false,code:"in_flight"}});
 expect(await reconcileOwnerBookingCardRemoval(input)).toEqual({ok:false,code:"in_flight"});
 expect(m.config).not.toHaveBeenCalled();expect(m.read).not.toHaveBeenCalled();expect(m.rpc).toHaveBeenCalledTimes(1);
});
