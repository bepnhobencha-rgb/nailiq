import { beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({ctx:vi.fn(),client:vi.fn(),reconcile:vi.fn(),limit:vi.fn(),refresh:vi.fn()}));
vi.mock("next/cache",()=>({revalidatePath:m.refresh}));
vi.mock("@/shared/dashboard/setupActions",()=>({getDashboardWriteClient:m.ctx}));
vi.mock("@/shared/lib/supabase/serviceRole",()=>({createServiceRoleClient:m.client}));
vi.mock("@/shared/lib/inAppRateLimit",()=>({isOverRateLimit:m.limit,durableRateLimitKey:()=>"synthetic-key"}));
vi.mock("../reconcileBookingCardRemoval",()=>({reconcileOwnerBookingCardRemoval:m.reconcile}));
import {loadOwnerCardRemovalExceptions,reconcileOwnerCardRemoval} from "../ownerCardRemovalActions";
const salon="11111111-1111-4111-8111-111111111111",op="22222222-2222-4222-8222-222222222222",actor="33333333-3333-4333-8333-333333333333",book="44444444-4444-4444-8444-444444444444";
const queries:{table:string;cols:string;filters:[string,unknown][]}[]=[];
let data:Record<string,unknown[]>;let failed:string|null;
function query(table:string){const q={table,cols:"",filters:[] as [string,unknown][]};queries.push(q);const c={
 select:(s:string)=>{q.cols=s;return c;},eq:(k:string,v:unknown)=>{q.filters.push([k,v]);return c;},in:(k:string,v:unknown)=>{q.filters.push([k,v]);return c;},is:(k:string,v:unknown)=>{q.filters.push([k,v]);return c;},order:()=>c,limit:()=>c,
 then:(resolve:(x:unknown)=>unknown)=>Promise.resolve({data:data[table]??[],error:failed===table?{}:null}).then(resolve),
};return c;}
beforeEach(()=>{vi.clearAllMocks();queries.length=0;failed=null;m.ctx.mockResolvedValue({salon:{id:salon},role:"owner",userId:actor});m.client.mockReturnValue({from:query});m.limit.mockResolvedValue(false);m.reconcile.mockResolvedValue({ok:false,code:"remove_unknown"});
 data={booking_card_management_operations:[{id:op,booking_id:book,status:"unknown",updated_at:"2026-09-12T00:00:00Z"}],bookings:[{id:book,client_name:"Synthetic Private Name",start_time_utc:"2026-09-20T10:00:00Z",services:{name:"QA Service"}}],booking_card_removal_recovery_events:[{operation_id:op,stage:"configuration",created_at:"2026-09-12T01:00:00Z"}]};});
describe("Owner removal action boundary",()=>{
 it.each([null,"receptionist","senior","nail_tech"])("%s cannot read or act",async role=>{
  m.ctx.mockResolvedValue(role?{salon:{id:salon},role,userId:actor}:null);
  expect((await loadOwnerCardRemovalExceptions("qa")).ok).toBe(false);expect((await reconcileOwnerCardRemoval("qa",op)).code).toBe("unauthorized");expect(m.client).not.toHaveBeenCalled();expect(m.reconcile).not.toHaveBeenCalled();
 });
 it("demo context without authenticated actor cannot act or read",async()=>{
  m.ctx.mockResolvedValue({salon:{id:salon},role:"owner",userId:null});expect((await loadOwnerCardRemovalExceptions("qa")).ok).toBe(false);expect((await reconcileOwnerCardRemoval("qa",op)).ok).toBe(false);expect(m.reconcile).not.toHaveBeenCalled();
 });
 it.each(["owner","admin"])("%s uses trusted salon and actor only",async role=>{
  m.ctx.mockResolvedValue({salon:{id:salon},role,userId:actor});await reconcileOwnerCardRemoval("qa",op);
  expect(m.reconcile).toHaveBeenCalledExactlyOnceWith({salonId:salon,actorId:actor,operationId:op});expect(m.refresh).toHaveBeenCalledWith("/dashboard/qa/no-show-protection");
 });
 it("rejects invalid ID and rate limit before recovery",async()=>{
  expect((await reconcileOwnerCardRemoval("qa","bad")).code).toBe("invalid_request");m.limit.mockResolvedValue(true);expect((await reconcileOwnerCardRemoval("qa",op)).code).toBe("rate_limited");expect(m.reconcile).not.toHaveBeenCalled();
 });
 it("projects initials and safe reason without provider material and scopes every query",async()=>{
  const r=await loadOwnerCardRemovalExceptions("qa");expect(r.items[0]).toMatchObject({clientLabel:"S. P.",reason:"configuration",lastAttemptAt:"2026-09-12T01:00:00Z"});
  expect(JSON.stringify(r)).not.toMatch(/Synthetic Private Name|card_id|customer_id|merchant_id|access_token|source_token/);
  expect(queries.every(q=>q.filters.some(([k,v])=>k==="salon_id"&&v===salon))).toBe(true);expect(queries.every(q=>!q.cols.includes("provider_material"))).toBe(true);
 });
 it("does not show recovered or deleted bookings",async()=>{
  await loadOwnerCardRemovalExceptions("qa");expect(queries[0].filters).toContainEqual(["recovery",null]);
  data.bookings=[];expect((await loadOwnerCardRemovalExceptions("qa")).items).toEqual([]);
 });
 it.each(["booking_card_management_operations","bookings","booking_card_removal_recovery_events","booking_card_removal_delivery_events"])("%s failure never becomes empty success",async table=>{
  failed=table;expect(await loadOwnerCardRemovalExceptions("qa")).toEqual({ok:false,items:[]});
 });
 it("unknown diagnostic stage does not expose raw text",async()=>{
  data.booking_card_removal_recovery_events=[{operation_id:op,stage:"raw@example.invalid",created_at:"2026-09-12T01:00:00Z"}];expect((await loadOwnerCardRemovalExceptions("qa")).items[0].reason).toBeNull();
 });
});

describe("Owner delivery visibility",()=>{
 it.each(["dispatch_preparation","provider_preflight","provider_mutation","receipt_validation","provider_unknown"])("visibility maps delivery stage %s without raw metadata",async stage=>{
  data.booking_card_removal_recovery_events=[];
  data.booking_card_removal_delivery_events=[{operation_id:op,stage,created_at:"2026-09-12T02:00:00Z",square_codes:["SECRET"],http_status:503,source_token:"secret"}];
  const r=await loadOwnerCardRemovalExceptions("qa");expect(r.items[0]).toMatchObject({reason:stage,lastAttemptAt:"2026-09-12T02:00:00Z"});
  expect(JSON.stringify(r)).not.toMatch(/SECRET|secret|503|square_codes/);
  expect(queries.find(q=>q.table==="booking_card_removal_delivery_events")?.cols).toBe("operation_id,stage,created_at");
 });
 it("visibility uses the latest delivery or recovery event by actual instant",async()=>{
  data.booking_card_removal_delivery_events=[{operation_id:op,stage:"provider_mutation",created_at:"2026-09-11T19:00:00-07:00"}];
  expect((await loadOwnerCardRemovalExceptions("qa")).items[0].reason).toBe("provider_mutation");
  data.booking_card_removal_recovery_events=[{operation_id:op,stage:"authority",created_at:"2026-09-12T03:00:00Z"}];
  expect((await loadOwnerCardRemovalExceptions("qa")).items[0].reason).toBe("authority");
 });
 it("visibility prefers recovery when both event timestamps match",async()=>{
  data.booking_card_removal_delivery_events=[{operation_id:op,stage:"provider_mutation",created_at:"2026-09-12T01:00:00Z"}];expect((await loadOwnerCardRemovalExceptions("qa")).items[0].reason).toBe("configuration");
 });
 it.each(["unknown","sending","failed"])("visibility shows %s without granting new reconciliation authority",async status=>{
  data.booking_card_management_operations=[{id:op,booking_id:book,status,updated_at:"2026-09-12T00:00:00Z"}];const r=await loadOwnerCardRemovalExceptions("qa");expect(r.items[0].canReconcile).toBe(status==="unknown");
  expect(queries[0].filters).toContainEqual(["status",["unknown","sending","failed"]]);expect(m.reconcile).not.toHaveBeenCalled();
 });
 it("visibility fails closed on delivery query outage",async()=>{failed="booking_card_removal_delivery_events";expect(await loadOwnerCardRemovalExceptions("qa")).toEqual({ok:false,items:[]});});
 it("visibility hides an unrecognized newest delivery reason without selecting older reassuring copy",async()=>{
  data.booking_card_removal_delivery_events=[{operation_id:op,stage:"secret@example.com",created_at:"2026-09-12T02:00:00Z"}];const r=await loadOwnerCardRemovalExceptions("qa");expect(r.items[0].reason).toBeNull();expect(JSON.stringify(r)).not.toContain("secret@");
 });
});

describe("stale prepared removal visibility",()=>{
 it.each([null,"invalid",new Date(Date.now()+60000).toISOString(),new Date().toISOString()])("does not offer recovery for unprepared/recent binding %s",async prepared=>{
  data.booking_card_management_operations=[{id:op,booking_id:book,status:"sending",updated_at:new Date().toISOString(),dispatch:prepared?{prepared_at:prepared}:null}];
  expect((await loadOwnerCardRemovalExceptions("qa")).items[0].canReconcile).toBe(false);
 });
 it("offers an Owner check for a stale prepared sending operation",async()=>{
  data.booking_card_management_operations=[{id:op,booking_id:book,status:"sending",updated_at:new Date().toISOString(),dispatch:{prepared_at:new Date(Date.now()-180000).toISOString()}}];
  expect((await loadOwnerCardRemovalExceptions("qa")).items[0].canReconcile).toBe(true);
 });
});
