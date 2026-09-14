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
const fixtures: Awaited<ReturnType<typeof seedReceptionistCenterFixture>>[]=[];
const card="ccof:synthetic_recovery",customer="synthetic_customer",merchant="synthetic_merchant";
let token:string,requestId:string,fp:string,op:string,source:string,foreignToken:string;
let originalOperation:unknown;
const evidence=process.env.NAILIQ_QA_ARTIFACT_DIR!;
function receipt(){appendFileSync(`${evidence}/fixture-history.jsonl`,JSON.stringify({salons:fixtures.map(f=>({id:f.salonId,slug:f.slug}))})+"\n");}
async function mint(index=0){const f=fixtures[index];const r=await db.rpc("mint_booking_management_capability",{
 p_salon_id:f.salonId,p_booking_id:f.displayApptBookingId,p_action:"card_manage",p_min_expires_at:new Date(Date.now()+600000).toISOString()});
 expect(r.error).toBeNull();expect(r.data.ok,String(r.data.code)).toBe(true);return r.data.token_id as string;}
function args(){return {p_token_id:token,p_request_id:requestId,p_card_fingerprint:fp};}
function proof(){return {operation_id:op,source_save_operation_id:source,card_id:card,customer_id:customer,
 merchant_id:merchant,environment:"sandbox",enabled:false,brand:"VISA",last4:"1111"};}
async function context(extra={}){const r=await db.rpc("get_booking_card_removal_recovery_context",{...args(),...extra});expect(r.error).toBeNull();return r.data;}
async function complete(value:unknown=proof()){const r=await db.rpc("complete_booking_card_removal_recovery",{...args(),p_receipt:value});expect(r.error).toBeNull();return r.data;}
test.beforeAll(async()=>{
 for(const label of ["a","b"]){
  fixtures.push(await seedReceptionistCenterFixture(`e2e-p003-removalrecovery-${label}-${randomUUID()}`));receipt();
  const f=fixtures.at(-1)!;const start=Date.now()+14*86400000;
  expect((await db.from("bookings").update({status:"confirmed",start_time_utc:new Date(start).toISOString(),end_time_utc:new Date(start+3600000).toISOString()})
    .eq("id",f.displayApptBookingId).eq("salon_id",f.salonId)).error).toBeNull();
 }
 const f=fixtures[0];
 expect((await db.from("bookings").update({noshow_card_id:card,noshow_customer_id:customer,noshow_card_brand:"VISA",noshow_card_last4:"1111",noshow_charge_status:null})
 .eq("id",f.displayApptBookingId).eq("salon_id",f.salonId)).error).toBeNull();
 const saveToken=await mint();source=randomUUID();
 const then=new Date(Date.now()-60000).toISOString();
 expect((await db.from("booking_card_save_operations").insert({id:source,capability_id:saveToken,salon_id:f.salonId,
 booking_id:f.displayApptBookingId,request_id:randomUUID(),provider:"square",mode:"save_card",source_fingerprint:"a".repeat(64),
 initial_card_fingerprint:"b".repeat(64),provider_material:{},status:"succeeded",attempt_token:randomUUID(),
 provider_reference:card,completion_fingerprint:"c".repeat(64),result_json:{ok:true,customer_id:customer},created_at:then,completed_at:then,
 expected_customer_id:customer,expected_merchant_id:merchant,expected_environment:"sandbox"})).error).toBeNull();
 expect((await db.from("booking_management_capabilities").update({revoked_at:new Date().toISOString(),revoke_reason:"manual_revoke"}).eq("id",saveToken)).error).toBeNull();
 token=await mint();foreignToken=await mint(1);requestId=randomUUID();
 const cap=await db.from("booking_management_capabilities").select("card_state_fingerprint").eq("id",token).single();
 expect(cap.error).toBeNull();fp=cap.data!.card_state_fingerprint;
 const claim=await db.rpc("claim_booking_card_management_operation",{p_token_id:token,p_request_id:requestId,p_expected_card_fingerprint:fp});
 expect(claim.error).toBeNull();expect(claim.data.code).toBe("claimed");op=claim.data.operation_id;
 const done=await db.rpc("complete_booking_card_management_operation",{p_operation_id:op,p_attempt_token:claim.data.attempt_token,
 p_outcome:"unknown",p_provider_reference:null,p_error_code:"provider_exception"});
 expect(done.error).toBeNull();expect(done.data.code).toBe("remove_unknown");
 originalOperation=(await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data;
});
test.afterAll(async()=>{for(const f of fixtures) await cleanupTestSalon(f.slug,{clearAllRateLimits:false});receipt();});
test("terminal unknown remains immutable in old completion but has a bound recovery context",async()=>{
 const r=await context();expect(r).toMatchObject({ok:true,code:"recovery_read_required",operation_id:op,source_save_operation_id:source,merchant_id:merchant,environment:"sandbox"});
 const before=originalOperation as {attempt_token:string};
 const old=await db.rpc("complete_booking_card_management_operation",{p_operation_id:op,p_attempt_token:before.attempt_token,p_outcome:"succeeded",p_provider_reference:card,p_error_code:null});
 expect(old.error).toBeNull();expect(old.data.code).toBe("completion_conflict");
});
test("wrong request, fingerprint and foreign salon token are rejected",async()=>{
 for(const change of [{p_request_id:randomUUID()},{p_card_fingerprint:"f".repeat(64)},{p_token_id:foreignToken}]) expect((await context(change)).ok).toBe(false);
});
test("missing historic identity does not authorize recovery",async()=>{
 expect((await db.from("booking_card_save_operations").update({expected_merchant_id:null}).eq("id",source)).error).toBeNull();
 try{expect((await context()).code).toBe("removal_manual_review");}
 finally{expect((await db.from("booking_card_save_operations").update({expected_merchant_id:merchant}).eq("id",source)).error).toBeNull();}
});
test("expired or revoked capability cannot start a recovery read",async()=>{
 const old=(await db.from("booking_management_capabilities").select("expires_at,revoked_at,revoke_reason").eq("id",token).single()).data!;
 for(const change of [{expires_at:new Date(Date.now()-1000).toISOString()},{revoked_at:new Date().toISOString(),revoke_reason:"manual_revoke"}]){
  expect((await db.from("booking_management_capabilities").update(change).eq("id",token)).error).toBeNull();
  try{expect((await context()).code).toBe("expired_or_revoked");}
  finally{expect((await db.from("booking_management_capabilities").update(old).eq("id",token)).error).toBeNull();}
 }
});
test("a newer card action epoch prevents stale recovery",async()=>{
 const f=fixtures[0];const query=()=>db.from("booking_management_action_state").select("epoch").eq("booking_id",f.displayApptBookingId).eq("action","card_manage").single();
 const old=(await query()).data!.epoch;
 const update=(epoch:number)=>db.from("booking_management_action_state").update({epoch}).eq("booking_id",f.displayApptBookingId).eq("action","card_manage");
 expect((await update(old+1)).error).toBeNull();
 try{expect((await complete()).code).toBe("booking_state_changed");}
 finally{expect((await update(old)).error).toBeNull();}
});
test("null, missing, enabled, wrong binding and wrong receipt cannot clear booking",async()=>{
 for(const value of [null,{}, {...proof(),enabled:true},{...proof(),enabled:"false"},{...proof(),card_id:"other"},
 {...proof(),customer_id:"other"},{...proof(),merchant_id:"other"},{...proof(),environment:"production"},
 {...proof(),source_save_operation_id:randomUUID()},{...proof(),last4:null},{...proof(),brand:null}]) expect((await complete(value)).code).toBe("invalid_recovery_receipt");
 const b=await db.from("bookings").select("noshow_card_id").eq("id",fixtures[0].displayApptBookingId).single();expect(b.data?.noshow_card_id).toBe(card);
});
test("changed card between read and completion is protected",async()=>{
 const bid=fixtures[0].displayApptBookingId;
 expect((await context()).ok).toBe(true);
 expect((await db.from("bookings").update({noshow_card_id:"ccof:new_card"}).eq("id",bid)).error).toBeNull();
 try{expect((await complete()).code).toBe("booking_state_changed");}
 finally{expect((await db.from("bookings").update({noshow_card_id:card}).eq("id",bid)).error).toBeNull();}
});
test("anon cannot read receipts or call either privileged RPC",async()=>{
 const anon=createClient(qa,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
 expect((await anon.from("booking_card_removal_recovery_receipts").select("*")).error?.code).toBe("42501");
 expect((await anon.rpc("get_booking_card_removal_recovery_context",args())).error?.code).toBe("42501");
 expect((await anon.rpc("complete_booking_card_removal_recovery",{...args(),p_receipt:proof()})).error?.code).toBe("42501");
});
test("concurrent completions produce one receipt, preserve original error, and replay without mutation",async()=>{
 const results=await Promise.all([complete(),complete(),complete()]);
 expect(results.every(r=>r.ok===true&&r.code==="removed")).toBe(true);
 expect(results.filter(r=>r.idempotent===false)).toHaveLength(1);
 const receipts=await db.from("booking_card_removal_recovery_receipts").select("operation_id").eq("operation_id",op);
 expect(receipts.error).toBeNull();expect(receipts.data).toHaveLength(1);
 expect((await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data).toEqual(originalOperation);
 expect(await context()).toEqual({ok:true,code:"removed",idempotent:true});
 const protection=await db.from("bookings").select("card_protection_status").eq("id",fixtures[0].displayApptBookingId).single();
 expect(protection.data?.card_protection_status).toBe("retry_required");
 const b=await db.from("bookings").select("noshow_card_id,noshow_customer_id,noshow_charge_status").eq("id",fixtures[0].displayApptBookingId).single();
 expect(b.data).toEqual({noshow_card_id:null,noshow_customer_id:null,noshow_charge_status:"removed_by_customer"});
});
test("recovered state still requires matching card customer merchant environment and chronology",async()=>{
 const original=(await db.from("booking_card_save_operations").select("provider_reference,result_json,expected_merchant_id,expected_environment,completed_at").eq("id",source).single()).data!;
 const bookingId=fixtures[0].displayApptBookingId;
 async function refresh(){
  const r=await db.from("bookings").update({card_protection_status:"not_required"}).eq("id",bookingId).select("card_protection_status").single();expect(r.error).toBeNull();return r.data!.card_protection_status;
 }
 for(const patch of [{provider_reference:"ccof:other"},{result_json:{ok:true,customer_id:"other"}},
   {expected_merchant_id:"other_merchant"},{expected_environment:"production"},{completed_at:new Date(Date.now()+60000).toISOString()}]){
  expect((await db.from("booking_card_save_operations").update(patch).eq("id",source)).error).toBeNull();
  try{expect(await refresh()).toBe("manual_review");}
  finally{expect((await db.from("booking_card_save_operations").update(original).eq("id",source)).error).toBeNull();}
  expect(await refresh()).toBe("retry_required");
 }
 expect((await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data).toEqual(originalOperation);
});
test("Preview reload of a pending removal uses the durable recovery receipt",async({browser})=>{
 test.skip(!process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE,"Separate Preview gate needs an authenticated QA deployment");
 const origin="https://nailiq-p0-signup-qa-20260911.vercel.app";
 const access=readFileSync(process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE!,"utf8").trim();
 expect(new URL(access).origin).toBe(origin);
 const http=await request.newContext({baseURL:origin});await http.get(access);
 const c=await browser.newContext({baseURL:origin,storageState:await http.storageState(),viewport:{width:390,height:844}});
 try{
  const page=await c.newPage();await page.goto("/booking/card");
  await expect(page.getByRole("heading",{name:"Your saved card"})).toBeVisible();
  const key="nailiq:booking-management-pending:"+createHash("sha256").update(JSON.stringify({v:1,action:"card_manage",token})).digest("hex");
  await page.evaluate(({key,value})=>sessionStorage.setItem(key,JSON.stringify(value)),{key,value:{requestId,material:fp,createdAt:Date.now()}});
  const response=page.waitForResponse(r=>r.url().includes("/api/booking/remove-card")&&r.request().method()==="POST");
  await page.goto(`/booking/card?token=${token}`);
  const r=await response;expect(r.status()).toBe(200);expect(await r.json()).toMatchObject({ok:true,code:"removed",idempotent:true});
  await expect(page.getByText("Card removed ✓",{exact:true})).toBeVisible();
  expect(await page.evaluate(key=>sessionStorage.getItem(key),key)).toBeNull();
  await page.screenshot({path:`${evidence}/recovered-removal-mobile.png`,fullPage:true});
  expect((await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data).toEqual(originalOperation);
 }finally{await c.close();await http.dispose();}
});
