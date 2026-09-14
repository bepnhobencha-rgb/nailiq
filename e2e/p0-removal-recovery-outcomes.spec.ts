import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { test, expect, request } from "@playwright/test";
import { cleanupTestSalon } from "./helpers/db";
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
const fixtures: Awaited<ReturnType<typeof seedReceptionistCenterFixture>>[]=[];
const card="ccof:synthetic_binding",customer="synthetic_customer",merchant="synthetic_merchant";
let token:string,requestId:string,fp:string,op:string,attempt:string;
function args(){return {p_token_id:token,p_request_id:requestId,p_card_fingerprint:fp};}
function proof(){return {operation_id:op,source_save_operation_id:null,source_removal_binding_id:op,
 card_id:card,customer_id:customer,merchant_id:merchant,environment:"sandbox",enabled:false,brand:"VISA",last4:"1111"};}
async function prep(extra={}){const r=await db.rpc("prepare_booking_card_removal_dispatch",{
 p_operation_id:op,p_attempt_token:attempt,p_provider:"square",p_merchant_id:merchant,p_environment:"sandbox",...extra});
 expect(r.error).toBeNull();return r.data;}
async function recover(value:unknown=proof()){const r=await db.rpc("complete_booking_card_removal_recovery",{...args(),p_receipt:value});expect(r.error).toBeNull();return r.data;}
function receipt(){appendFileSync(`${evidence}/fixture-history.jsonl`,JSON.stringify({salons:fixtures.map(f=>({id:f.salonId,slug:f.slug}))})+"\n");}
test.beforeAll(async()=>{
 for(const label of ["a","b"]){fixtures.push(await seedReceptionistCenterFixture(`e2e-p003-removaloutcomes-${label}-${randomUUID()}`));receipt();}
 const f=fixtures[0];const start=Date.now()+14*86400000;
 expect((await db.from("bookings").update({status:"confirmed",start_time_utc:new Date(start).toISOString(),end_time_utc:new Date(start+3600000).toISOString(),
 noshow_card_id:card,noshow_customer_id:customer,noshow_card_brand:"VISA",noshow_card_last4:"1111",noshow_charge_status:null})
 .eq("id",f.displayApptBookingId).eq("salon_id",f.salonId)).error).toBeNull();
 const mint=await db.rpc("mint_booking_management_capability",{p_salon_id:f.salonId,p_booking_id:f.displayApptBookingId,p_action:"card_manage",p_min_expires_at:new Date(Date.now()+600000).toISOString()});
 expect(mint.error).toBeNull();expect(mint.data.ok,String(mint.data.code)).toBe(true);token=mint.data.token_id;requestId=randomUUID();
 const c=await db.from("booking_management_capabilities").select("card_state_fingerprint").eq("id",token).single();expect(c.error).toBeNull();fp=c.data!.card_state_fingerprint;
 const claim=await db.rpc("claim_booking_card_management_operation",{p_token_id:token,p_request_id:requestId,p_expected_card_fingerprint:fp});
 expect(claim.error).toBeNull();expect(claim.data.code).toBe("claimed");op=claim.data.operation_id;attempt=claim.data.attempt_token;
 expect((await prep()).ok).toBe(true);
 expect((await db.from("square_integrations").select("salon_id").eq("salon_id",f.salonId)).data).toEqual([]);
 const done=await db.rpc("complete_booking_card_management_operation",{p_operation_id:op,p_attempt_token:attempt,p_outcome:"unknown",p_provider_reference:null,p_error_code:"provider_exception"});
 expect(done.error).toBeNull();expect(done.data.code).toBe("remove_unknown");
});
test.afterAll(async()=>{for(const f of fixtures)await cleanupTestSalon(f.slug,{clearAllRateLimits:false});receipt();});
const eventId=randomUUID();
function diagnostic(){return {...args(),p_event_id:eventId,p_provider:"square",p_stage:"provider_read",p_code:"reconciliation_read_failed",
 p_retryability:"reconcile_first",p_read_status:"failed",p_http_status:503,p_square_codes:["SERVICE_UNAVAILABLE"],p_square_categories:["API_ERROR"]};}
async function record(extra={}){const r=await db.rpc("record_booking_card_removal_recovery_outcome",{...diagnostic(),...extra});expect(r.error).toBeNull();return r.data;}
async function events(){const r=await db.from("booking_card_removal_recovery_events").select("*").eq("operation_id",op).order("created_at");expect(r.error).toBeNull();return r.data!;}
test("concurrent duplicate diagnostics write one event and derive tenant identity",async()=>{
 const r=await Promise.all([record(),record(),record()]);expect(r.every(x=>x.ok===true)).toBe(true);expect(r.filter(x=>x.idempotent===false)).toHaveLength(1);
 const e=await events();expect(e).toHaveLength(1);expect(e[0]).toMatchObject({id:eventId,operation_id:op,salon_id:fixtures[0].salonId,booking_id:fixtures[0].displayApptBookingId,
 stage:"provider_read",code:"reconciliation_read_failed",read_status:"failed",http_status:503});expect(Number.isFinite(Date.parse(e[0].created_at))).toBe(true);
});
test("later outcomes append and cannot rewrite the first cause or original operation",async()=>{
 const old=(await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data;
 const first=(await events())[0];
 expect((await record({p_code:"reconciliation_not_found",p_retryability:"manual_review"})).code).toBe("outcome_conflict");
 expect((await record({p_event_id:randomUUID(),p_code:"reconciliation_card_active",p_retryability:"manual_review",p_read_status:"completed",p_http_status:200,p_square_codes:[],p_square_categories:[]})).ok).toBe(true);
 expect(await events()).toHaveLength(2);expect((await events())[0]).toEqual(first);
 expect((await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data).toEqual(old);
});
test("strict diagnostics reject unallowlisted strings nulls inconsistent stages and oversized arrays",async()=>{
 const before=await events();
 for(const extra of [{p_stage:"raw@example.invalid"},{p_code:"source_secret"},{p_retryability:"new_card"},{p_read_status:"completed"},
 {p_stage:null},{p_code:null},{p_provider:null},{p_http_status:999},{p_square_codes:["source_secret"]},{p_square_codes:[null]},
 {p_square_categories:["phone_secret"]},{p_square_codes:Array(9).fill("NOT_FOUND")},{p_square_codes:null},
 {p_stage:"configuration",p_code:"square_config_unavailable",p_read_status:"not_requested"}]){
  expect((await record({p_event_id:randomUUID(),...extra})).code).toBe("invalid_diagnostic");
 }
 expect(await events()).toEqual(before);
});
test("wrong token request fingerprint and cross-salon capability cannot attach an event",async()=>{
 const other=await db.rpc("mint_booking_management_capability",{p_salon_id:fixtures[1].salonId,p_booking_id:fixtures[1].displayApptBookingId,p_action:"card_manage",p_min_expires_at:new Date(Date.now()+600000).toISOString()});
 expect(other.error).toBeNull();expect(other.data.ok).toBe(true);
 for(const extra of [{p_token_id:randomUUID()},{p_request_id:randomUUID()},{p_card_fingerprint:"b".repeat(64)},{p_token_id:other.data.token_id}])
  expect((await record({p_event_id:randomUUID(),...extra})).code).toBe("invalid_request");
 expect(await events()).toHaveLength(2);
});
test("anon cannot read or append and service cannot rewrite diagnostics directly",async()=>{
 const anon=createClient(qa,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
 expect((await anon.from("booking_card_removal_recovery_events").select("*")).error?.code).toBe("42501");
 expect((await anon.rpc("record_booking_card_removal_recovery_outcome",diagnostic())).error?.code).toBe("42501");
 expect((await db.from("booking_card_removal_recovery_events").update({code:"source_secret"}).eq("id",eventId)).error?.code).toBe("42501");
 expect((await db.from("booking_card_removal_recovery_events").delete().eq("id",eventId)).error?.code).toBe("42501");
});
test("expired and revoked capability may identify history but gains no recovery authority",async()=>{
 const before=(await db.from("booking_management_capabilities").select("*").eq("id",token).single()).data!;
 for(const change of [{expires_at:new Date(Date.now()-1000).toISOString()},{revoked_at:new Date().toISOString(),revoke_reason:"manual_revoke"}]){
  expect((await db.from("booking_management_capabilities").update(change).eq("id",token)).error).toBeNull();
  const frozen=(await db.from("booking_management_capabilities").select("*").eq("id",token).single()).data;
  try{
   expect((await record({p_event_id:randomUUID(),p_provider:null,p_stage:"authority",p_code:"recovery_authority_expired_or_revoked",p_retryability:"manual_review",p_read_status:"not_requested",p_http_status:null,p_square_codes:[],p_square_categories:[]})).ok).toBe(true);
   expect((await db.rpc("get_booking_card_removal_recovery_context",args())).data.code).toBe("expired_or_revoked");
   expect((await recover()).code).toBe("expired_or_revoked");
   expect((await db.from("booking_management_capabilities").select("*").eq("id",token).single()).data).toEqual(frozen);
  }finally{expect((await db.from("booking_management_capabilities").update({expires_at:before.expires_at,revoked_at:before.revoked_at,revoke_reason:before.revoke_reason}).eq("id",token)).error).toBeNull();}
 }
});
test("Preview failed recovery records configuration cause and keeps pending request on reload",async({browser})=>{
 test.skip(!process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE,"Preview access required");
 const origin="https://nailiq-p0-signup-qa-20260911.vercel.app";const access=readFileSync(process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE!,"utf8").trim();expect(new URL(access).origin).toBe(origin);
 const http=await request.newContext({baseURL:origin});await http.get(access);
 const c=await browser.newContext({baseURL:origin,storageState:await http.storageState(),viewport:{width:390,height:844}});
 try{
  const page=await c.newPage();await page.goto("/booking/card");await expect(page.getByRole("heading",{name:"Your saved card"})).toBeVisible();
  const key="nailiq:booking-management-pending:"+createHash("sha256").update(JSON.stringify({v:1,action:"card_manage",token})).digest("hex");
  await page.evaluate(({key,value})=>sessionStorage.setItem(key,JSON.stringify(value)),{key,value:{requestId,material:fp,createdAt:Date.now()}});
  const before=(await events()).length;
  for(let i=0;i<2;i++){
   const response=page.waitForResponse(r=>r.url().includes("/api/booking/remove-card")&&r.request().method()==="POST");
   if(i===0)await page.goto(`/booking/card?token=${token}`);else await page.reload();
   const res=await response;expect(res.status()).toBe(503);expect(await res.json()).toMatchObject({ok:false,code:"remove_unknown"});
   expect(await page.evaluate(key=>sessionStorage.getItem(key),key)).not.toBeNull();
   await expect(page.getByText("Card removed ✓",{exact:true})).toHaveCount(0);
   const e=await events();expect(e).toHaveLength(before+i+1);expect(e.at(-1)).toMatchObject({code:"square_config_unavailable",stage:"configuration",read_status:"not_requested",provider:"square",http_status:null});
  }
  await page.screenshot({path:`${evidence}/unknown-removal-mobile.png`,fullPage:true});
  expect((await db.from("bookings").select("noshow_card_id,noshow_customer_id").eq("id",fixtures[0].displayApptBookingId).single()).data).toEqual({noshow_card_id:card,noshow_customer_id:customer});
  expect((await db.from("booking_card_management_operations").select("status,error_code").eq("id",op).single()).data).toEqual({status:"unknown",error_code:"provider_exception"});
 }finally{await c.close();await http.dispose();}
});
test("positive synthetic receipt resolves without erasing negative outcome history",async()=>{
 const before=await events();expect((await recover()).ok).toBe(true);expect((await recover()).idempotent).toBe(true);
 expect(await events()).toEqual(before);
});
