import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({ context:vi.fn(),client:vi.fn(),limit:vi.fn(),reconcile:vi.fn(),refresh:vi.fn() }));
vi.mock("server-only",()=>({}));
vi.mock("next/cache",()=>({revalidatePath:mocks.refresh}));
vi.mock("@/shared/dashboard/setupActions",()=>({getDashboardWriteClient:mocks.context}));
vi.mock("@/shared/lib/supabase/serviceRole",()=>({createServiceRoleClient:mocks.client}));
vi.mock("@/shared/lib/inAppRateLimit",()=>({isOverRateLimit:mocks.limit,durableRateLimitKey:()=>"safe-hash"}));
vi.mock("../reconcileBookingCardSaveOperations",()=>({reconcileBookingCardSaveOperations:mocks.reconcile}));
import { actOnCardProtectionException, loadCardProtectionExceptions } from "../cardProtectionExceptionActions";
const salon="55630000-0000-4000-8000-000000000001",booking="55630000-0000-4000-8000-000000000002";
const queries:{table:string;filters:[string,unknown][];columns:string}[]=[];
let result:Record<string,unknown>={};
function query(table:string) {
  const entry={table,filters:[] as [string,unknown][],columns:""};queries.push(entry);
  const chain={
    select:(value:string)=>{entry.columns=value;return chain;},eq:(column:string,value:unknown)=>{entry.filters.push([column,value]);return chain;},
    is:()=>chain,neq:()=>chain,in:()=>chain,order:()=>chain,limit:()=>chain,gt:()=>chain,or:()=>chain,
    maybeSingle:async()=>({data:result[table]??null,error:null}),
    then:(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:result[table]??[],error:null}).then(resolve),
  };return chain;
}
beforeEach(()=>{vi.clearAllMocks();queries.length=0;result={};mocks.limit.mockResolvedValue(false);
  mocks.context.mockResolvedValue({role:"owner",salon:{id:salon},userId:"55630000-0000-4000-8000-000000000010"});
  mocks.client.mockReturnValue({from:query,rpc:vi.fn().mockResolvedValue({data:{ok:true},error:null})});});
describe("Card protection exception access and minimal disclosure",()=>{
  it.each([null,"receptionist","nail_tech","senior"])("denies %s before privileged reads or actions",async(role)=>{
    mocks.context.mockResolvedValue(role?{role,salon:{id:salon}}:null);
    expect((await loadCardProtectionExceptions("qa")).ok).toBe(false);
    for(const action of ["retry_link","reconcile","reviewed"] as const) expect((await actOnCardProtectionException("qa",booking,action)).ok).toBe(false);
    expect(mocks.client).not.toHaveBeenCalled();expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it("every action checks the current salon; a foreign booking produces no provider call or mint",async()=>{
    for(const action of ["retry_link","reconcile","reviewed"] as const) expect((await actOnCardProtectionException("qa",booking,action)).ok).toBe(false);
    expect(queries).toHaveLength(3);expect(queries.every(q=>q.table==="bookings"&&q.filters.some(([c,v])=>c==="salon_id"&&v===salon))).toBe(true);
    expect(mocks.reconcile).not.toHaveBeenCalled();expect(mocks.client().rpc).not.toHaveBeenCalled();
  });
  it("only returns initials and safe status; both booking and operation reads are tenant scoped",async()=>{
    result={bookings:[{id:booking,client_name:"Synthetic Private Customer",start_time_utc:"2026-10-01T10:00:00Z",card_protection_status:"retry_required",services:{name:"QA Service"}}],
      booking_card_save_operations:[{booking_id:booking,first_failure_stage:"card_create",first_failure_code:"square_card_create_failed",updated_at:"2026-09-11T10:00:00Z",reviewed_at:null}]};
    const loaded=await loadCardProtectionExceptions("qa");expect(loaded.items[0].clientLabel).toBe("S. P.");
    expect(JSON.stringify(loaded)).not.toMatch(/Synthetic Private Customer|client_phone|client_email|source_token|access_token|provider_material/);
    expect(queries.every(q=>q.filters.some(([c,v])=>c==="salon_id"&&v===salon))).toBe(true);
    expect(queries.every(q=>!q.columns.includes("provider_material")&&!q.columns.includes("token"))).toBe(true);
  });
  it("reuses a valid secure link on an owner action replay instead of revoking it",async()=>{
    const token="55630000-0000-4000-8000-000000000020";
    result={bookings:{id:booking},booking_management_capabilities:{id:token}};
    const a=await actOnCardProtectionException("qa",booking,"retry_link");const b=await actOnCardProtectionException("qa",booking,"retry_link");
    expect(a.retryPath).toBe(`/booking/save-card?token=${token}`);expect(b).toEqual(a);expect(mocks.client().rpc).not.toHaveBeenCalled();
  });
});

it("owner can mark a legacy booking reviewed without any save operation",async()=>{
  result={bookings:{id:booking}};
  expect((await actOnCardProtectionException("qa",booking,"reviewed")).ok).toBe(true);
  expect(mocks.client().rpc).toHaveBeenCalledWith("mark_booking_card_protection_reviewed",expect.objectContaining({p_booking_id:booking,p_salon_id:salon}));
  expect(mocks.reconcile).not.toHaveBeenCalled();
  expect(queries.some(q=>q.table==="booking_card_save_operations")).toBe(false);
});
