import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServerClient } from "@supabase/ssr";
import { test, expect, request } from "@playwright/test";
import { seedTestUser, cleanupTestUser, cleanupTestSalon } from "./helpers/db";
import { seedReceptionistCenterFixture, supabaseAdmin as db } from "./receptionist-center/helpers";
const qa = "https://osdqutwunokiielbairj.supabase.co";
if (process.env.NEXT_PUBLIC_SUPABASE_URL !== qa || process.env.SUPABASE_INTERNAL_URL !== qa
 || process.env.NAILIQ_CARD_SAVE_DISPATCH_DISABLED !== "true"
 || ["DISABLE_OUTBOUND_SMS","DISABLE_OUTBOUND_EMAIL","DISABLE_OUTBOUND_CALLS"].some(k=>process.env[k]!=="1")) throw new Error("Disposable QA only");
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const u=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);
 if(u.origin!==qa) throw new Error("Non-QA transport forbidden");
 return originalFetch(input,{...init,redirect:"error"});
};
const evidence=process.env.NAILIQ_QA_ARTIFACT_DIR!;
const users: Awaited<ReturnType<typeof seedTestUser>>[]=[];
const fixtures: Awaited<ReturnType<typeof seedReceptionistCenterFixture>>[]=[];

const operations:{id:string;attempt:string;token:string;requestId:string;fp:string;bookingId:string;state:string}[]=[];
function receipt(){appendFileSync(`${evidence}/fixture-history.jsonl`,JSON.stringify({salons:fixtures.map(f=>({id:f.salonId,slug:f.slug})),users:users.map(u=>u.userId)})+"\n");}
async function delivery(op:typeof operations[number],receiptFailure=false){
 const r=await db.rpc("record_booking_card_removal_delivery_failure",{p_operation_id:op.id,p_attempt_token:op.attempt,p_event_id:randomUUID(),p_provider:"square",
 p_stage:receiptFailure?"receipt_validation":"configuration",p_code:receiptFailure?"removal_invalid_provider_receipt":"removal_configuration_unavailable",
 p_mutation_status:receiptFailure?"possibly_dispatched":"not_requested",p_retryability:"reconcile_first",p_reconciliation_outcome:"not_requested",p_http_status:null,p_square_codes:[],p_square_categories:[]});expect(r.error).toBeNull();expect(r.data.ok).toBe(true);
}
test.beforeAll(async()=>{
 for(const label of ["a","b"]){fixtures.push(await seedReceptionistCenterFixture(`e2e-p003-ownervisibility-${label}-${randomUUID()}`));receipt();}
 users.push(await seedTestUser());receipt();const f=fixtures[0];
 expect((await db.from("salon_members").insert({salon_id:f.salonId,user_id:users[0].userId,role:"owner"})).error).toBeNull();
 const base=await db.from("bookings").select("salon_id,service_id,staff_id,price_cents").eq("id",f.displayApptBookingId).single();expect(base.error).toBeNull();
 for(const [i,state] of ["unknown","sending","failed"].entries()){
  const start=Date.now()+14*86400000+i*7200000;
  const b=await db.from("bookings").insert({...base.data,client_name:`Synthetic ${state}`,client_phone:null,client_notes:null,status:"confirmed",source:"appointment",
   start_time_utc:new Date(start).toISOString(),end_time_utc:new Date(start+3600000).toISOString(),noshow_card_id:`ccof:synthetic_${state}`,noshow_customer_id:`synthetic_${state}`,noshow_card_brand:"VISA",noshow_card_last4:"1111",noshow_charge_status:null}).select("id").single();expect(b.error).toBeNull();
  const mint=await db.rpc("mint_booking_management_capability",{p_salon_id:f.salonId,p_booking_id:b.data!.id,p_action:"card_manage",p_min_expires_at:new Date(Date.now()+1200000).toISOString()});expect(mint.error).toBeNull();expect(mint.data.ok).toBe(true);
  const cap=await db.from("booking_management_capabilities").select("card_state_fingerprint").eq("id",mint.data.token_id).single();expect(cap.error).toBeNull();const requestId=randomUUID();
  const claim=await db.rpc("claim_booking_card_management_operation",{p_token_id:mint.data.token_id,p_request_id:requestId,p_expected_card_fingerprint:cap.data!.card_state_fingerprint});expect(claim.error).toBeNull();expect(claim.data.code).toBe("claimed");
  const op={id:claim.data.operation_id,attempt:claim.data.attempt_token,token:mint.data.token_id,requestId,fp:cap.data!.card_state_fingerprint,bookingId:b.data!.id,state};operations.push(op);
  if(state==="unknown"){
   const prep=await db.rpc("prepare_booking_card_removal_dispatch",{p_operation_id:op.id,p_attempt_token:op.attempt,p_provider:"square",p_merchant_id:"synthetic_merchant",p_environment:"sandbox"});expect(prep.error).toBeNull();expect(prep.data.ok).toBe(true);
  }
  await delivery(op,state==="unknown");
  if(state!=="sending"){
   const done=await db.rpc("complete_booking_card_management_operation",{p_operation_id:op.id,p_attempt_token:op.attempt,p_outcome:state,p_provider_reference:null,p_error_code:state==="unknown"?"removal_invalid_provider_receipt":"removal_configuration_invalid"});expect(done.error).toBeNull();expect(done.data.code).toBe(state==="unknown"?"remove_unknown":"remove_failed");
  }
 }
 expect((await db.from("square_integrations").select("salon_id").eq("salon_id",f.salonId)).data).toEqual([]);
});
test.afterAll(async()=>{for(const f of fixtures)await cleanupTestSalon(f.slug,{clearAllRateLimits:false});for(const u of users)await cleanupTestUser(u.userId);receipt();});
test("Owner sees delivery reasons and safe controls across pending failed unknown and recovered states",async({browser})=>{
 const origin="https://nailiq-p0-signup-qa-20260911.vercel.app";const jar=new Map<string,string>();
 const auth=createServerClient(qa,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:values=>{for(const v of values)jar.set(v.name,v.value);}}});
 expect((await auth.auth.signInWithPassword({email:users[0].email,password:users[0].password})).error).toBeNull();
 const http=await request.newContext({baseURL:origin,storageState:{origins:[],cookies:[...jar].map(([name,value])=>({name,value,domain:new URL(origin).hostname,path:"/",expires:-1,httpOnly:false,secure:true,sameSite:"Lax" as const}))}});
 await http.get(readFileSync(process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE!,"utf8").trim());const bc=await browser.newContext({storageState:await http.storageState(),viewport:{width:1280,height:1000}});
 const path=`/dashboard/${fixtures[0].slug}/no-show-protection`;const op=operations[0];
 const original=(await db.from("booking_card_management_operations").select("id,status,error_code").in("id",operations.map(o=>o.id)).order("id")).data;
 try{
  await bc.addInitScript(()=>{if(!localStorage.getItem("nailiq-user-lang"))localStorage.setItem("nailiq-user-lang","vi");});const page=await bc.newPage();await page.goto(origin+path);
  const panel=page.getByTestId("owner-card-removal-exceptions");await expect(panel).toBeVisible({timeout:45000});const rows=panel.getByTestId("removal-exception");await expect(rows).toHaveCount(3);
  const unknown=rows.filter({hasText:"S. u."});await expect(unknown.getByText("Chưa xác minh được xác nhận gỡ thẻ",{exact:true})).toBeVisible();await expect(unknown.getByRole("button")).toBeEnabled();
  for(const label of ["S. s.","S. f."]){const row=rows.filter({hasText:label});await expect(row.getByText("Chưa kết nối được dịch vụ thẻ",{exact:true})).toBeVisible();await expect(row.getByRole("button")).toBeDisabled();}
  expect(await panel.innerText()).not.toMatch(/ccof:|synthetic_|removal_invalid|Synthetic unknown|@/);await panel.screenshot({path:`${evidence}/owner-visibility-desktop-vi.png`});
  const r=await db.rpc("record_booking_card_removal_recovery_outcome",{p_token_id:op.token,p_request_id:op.requestId,p_card_fingerprint:op.fp,p_event_id:randomUUID(),p_provider:"square",p_stage:"provider_read",p_code:"reconciliation_read_failed",p_retryability:"reconcile_first",p_read_status:"failed",p_http_status:503,p_square_codes:["SERVICE_UNAVAILABLE"],p_square_categories:["API_ERROR"]});expect(r.error).toBeNull();expect(r.data.ok).toBe(true);
  await page.reload();await expect(unknown.getByText("Cần kiểm tra xác nhận từ dịch vụ thẻ",{exact:true})).toBeVisible();
  await delivery(op,true);await page.reload();await expect(unknown.getByText("Chưa xác minh được xác nhận gỡ thẻ",{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>localStorage.setItem("nailiq-user-lang","en"));await page.reload();await expect(panel.getByRole("heading",{name:"Card removal requests"})).toBeVisible();await panel.screenshot({path:`${evidence}/owner-visibility-mobile-en.png`});
  const observed=page.waitForRequest(r=>!!r.headers()["next-action"]&&r.postData()===JSON.stringify([fixtures[0].slug,op.id]));await unknown.getByRole("button").click();const actionId=(await observed).headers()["next-action"];await expect(panel.getByRole("status")).toBeVisible();await expect(unknown.getByText("Card service connection unavailable",{exact:true})).toBeVisible();
  for(const blocked of operations.slice(1)){
   const r=await bc.request.post(origin+path,{headers:{Origin:origin,"next-action":actionId,"content-type":"text/plain;charset=UTF-8",accept:"text/x-component"},data:JSON.stringify([fixtures[0].slug,blocked.id])});
   expect(await r.text()).toContain('"ok":false');
  }
  expect((await db.from("booking_card_management_operations").select("id,status,error_code").in("id",operations.map(o=>o.id)).order("id")).data).toEqual(original);
  // Keep the denied tenant's redirect separate from the active Owner page.
  const foreign=await bc.newPage();
  try {
   await foreign.goto(`${origin}/dashboard/${fixtures[1].slug}/no-show-protection`);
   await expect(foreign).not.toHaveURL(`${origin}/dashboard/${fixtures[1].slug}/no-show-protection`);
   await expect(foreign.getByTestId("removal-exception")).toHaveCount(0);
  } finally { await foreign.close(); }
  const done=await db.rpc("complete_owner_booking_card_removal_recovery",{p_salon_id:fixtures[0].salonId,p_operation_id:op.id,p_actor_id:users[0].userId,p_receipt:{operation_id:op.id,source_save_operation_id:null,source_removal_binding_id:op.id,
   card_id:"ccof:synthetic_unknown",customer_id:"synthetic_unknown",merchant_id:"synthetic_merchant",environment:"sandbox",enabled:false,brand:"VISA",last4:"1111"}});expect(done.error).toBeNull();expect(done.data.ok).toBe(true);
  await page.goto(origin+path);await expect(rows).toHaveCount(2);await expect(unknown).toHaveCount(0);expect((await db.from("booking_card_management_operations").select("id,status,error_code").in("id",operations.map(o=>o.id)).order("id")).data).toEqual(original);
 }finally{await auth.auth.signOut({scope:"global"});await bc.close();await http.dispose();}
});
