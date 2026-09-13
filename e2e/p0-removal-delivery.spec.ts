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
const card="ccof:synthetic_binding",customer="synthetic_customer";
let token:string,requestId:string,fp:string,op:string,attempt:string;
function receipt(){appendFileSync(`${evidence}/fixture-history.jsonl`,JSON.stringify({salons:fixtures.map(f=>({id:f.salonId,slug:f.slug}))})+"\n");}
test.beforeAll(async()=>{
 for(const label of ["a","b"]){fixtures.push(await seedReceptionistCenterFixture(`e2e-p003-removaldelivery-${label}-${randomUUID()}`));receipt();}
 const f=fixtures[0];const start=Date.now()+14*86400000;
 expect((await db.from("bookings").update({status:"confirmed",start_time_utc:new Date(start).toISOString(),end_time_utc:new Date(start+3600000).toISOString(),
 noshow_card_id:card,noshow_customer_id:customer,noshow_card_brand:"VISA",noshow_card_last4:"1111",noshow_charge_status:null})
 .eq("id",f.displayApptBookingId).eq("salon_id",f.salonId)).error).toBeNull();
 const mint=await db.rpc("mint_booking_management_capability",{p_salon_id:f.salonId,p_booking_id:f.displayApptBookingId,p_action:"card_manage",p_min_expires_at:new Date(Date.now()+1200000).toISOString()});
 expect(mint.error).toBeNull();expect(mint.data.ok,String(mint.data.code)).toBe(true);token=mint.data.token_id;requestId=randomUUID();
 const c=await db.from("booking_management_capabilities").select("card_state_fingerprint").eq("id",token).single();expect(c.error).toBeNull();fp=c.data!.card_state_fingerprint;
 const claim=await db.rpc("claim_booking_card_management_operation",{p_token_id:token,p_request_id:requestId,p_expected_card_fingerprint:fp});
 expect(claim.error).toBeNull();expect(claim.data.code).toBe("claimed");op=claim.data.operation_id;attempt=claim.data.attempt_token;
 expect((await db.from("salons").update({payment_provider:"square"}).eq("id",f.salonId)).error).toBeNull();
 expect((await db.from("square_integrations").select("salon_id").eq("salon_id",f.salonId)).data).toEqual([]);
});
test.afterAll(async()=>{for(const f of fixtures)await cleanupTestSalon(f.slug,{clearAllRateLimits:false});receipt();});

function diagnostic(extra={}){return {p_operation_id:op,p_attempt_token:attempt,p_event_id:randomUUID(),p_provider:null,
 p_stage:"configuration",p_code:"removal_configuration_unavailable",p_retryability:"reconcile_first",p_mutation_status:"not_requested",
 p_reconciliation_outcome:"not_requested",p_http_status:null,p_square_codes:[],p_square_categories:[],...extra};}
async function record(value=diagnostic()){const r=await db.rpc("record_booking_card_removal_delivery_failure",value);expect(r.error).toBeNull();return r.data;}
async function snapshot(){return (await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data;}
test("wrong attempt or cross operation cannot write diagnostics",async()=>{
 const before=await snapshot();for(const extra of [{p_operation_id:randomUUID()},{p_attempt_token:randomUUID()},{p_attempt_token:null}])expect((await record(diagnostic(extra))).ok).toBe(false);
 expect((await db.from("booking_card_removal_delivery_events").select("id").eq("salon_id",fixtures[1].salonId)).data).toEqual([]);expect(await snapshot()).toEqual(before);
});
test("strict allowlists reject raw metadata and impossible stage combinations",async()=>{
 for(const extra of [{p_code:"raw-secret"},{p_stage:null},{p_mutation_status:"possibly_dispatched"},{p_retryability:"safe_retry"},{p_square_codes:["secret"]},{p_http_status:503},{p_square_categories:[null]},{p_reconciliation_outcome:"read_failed"}]){
  expect((await record(diagnostic(extra))).code).toBe("invalid_diagnostic");
 }
});
test("concurrent event replay is idempotent and append preserves first cause",async()=>{
 const before=await snapshot();const d=diagnostic();const r=await Promise.all([record(d),record(d),record(d)]);expect(r.every(x=>x.ok)).toBe(true);expect(r.filter(x=>!x.idempotent)).toHaveLength(1);
 expect((await record({...d,p_code:"removal_configuration_invalid"})).code).toBe("failure_conflict");
 expect((await record(diagnostic({p_provider:"square",p_stage:"provider_mutation",p_code:"removal_provider_write_failed",p_mutation_status:"possibly_dispatched",p_reconciliation_outcome:"read_failed",p_http_status:503,p_square_codes:["SERVICE_UNAVAILABLE"],p_square_categories:["API_ERROR"]}))).ok).toBe(true);
 expect((await db.from("booking_card_removal_delivery_events").select("id").eq("operation_id",op)).data).toHaveLength(2);expect(await snapshot()).toEqual(before);
});
test("anonymous RPC/read and direct service writes are denied",async()=>{
 const anon=createClient(qa,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
 expect((await anon.rpc("record_booking_card_removal_delivery_failure",diagnostic())).error?.code).toBe("42501");
 expect((await anon.from("booking_card_removal_delivery_events").select("*")).error?.code).toBe("42501");
 expect((await db.from("booking_card_removal_delivery_events").update({code:"removal_configuration_invalid"}).eq("operation_id",op)).error?.code).toBe("42501");
});
test("Preview reload records config failure without mutation or losing pending intent",async({browser})=>{
 const origin="https://nailiq-p0-signup-qa-20260911.vercel.app";const access=readFileSync(process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE!,"utf8").trim();expect(new URL(access).origin).toBe(origin);
 const http=await request.newContext({baseURL:origin});await http.get(access);const c=await browser.newContext({baseURL:origin,storageState:await http.storageState(),viewport:{width:390,height:844}});
 const before=await snapshot();const count=(await db.from("booking_card_removal_delivery_events").select("id").eq("operation_id",op)).data!.length;
 try{
  const page=await c.newPage();await page.goto("/booking/card");await expect(page.getByRole("heading",{name:"Your saved card"})).toBeVisible();
  const key="nailiq:booking-management-pending:"+createHash("sha256").update(JSON.stringify({v:1,action:"card_manage",token})).digest("hex");
  await page.evaluate(({key,value})=>sessionStorage.setItem(key,JSON.stringify(value)),{key,value:{requestId,material:fp,createdAt:Date.now()}});
  for(let i=0;i<2;i++){
   const response=page.waitForResponse(r=>r.url().includes("/api/booking/remove-card")&&r.request().method()==="POST");
   if(i===0)await page.goto(`/booking/card?token=${token}`);else await page.reload();
   const r=await response;expect(r.status()).toBe(503);expect(await r.json()).toMatchObject({ok:false,code:"card_management_unavailable"});
   await expect(page.locator("main").getByRole("alert")).toContainText("We cannot yet confirm that your card was removed.");
   expect(await page.evaluate(key=>sessionStorage.getItem(key),key)).not.toBeNull();
  }
  await page.screenshot({path:`${evidence}/initial-removal-pending-mobile.png`,fullPage:true});
  const events=await db.from("booking_card_removal_delivery_events").select("code,stage,mutation_status,reconciliation_outcome").eq("operation_id",op);
  expect(events.data).toHaveLength(count+2);expect(events.data!.filter(e=>e.code==="removal_configuration_unavailable")).toHaveLength(3);
  expect(await snapshot()).toEqual(before);
  expect((await db.from("booking_card_removal_dispatch_bindings").select("operation_id").eq("operation_id",op)).data).toEqual([]);
 }finally{await c.close();await http.dispose();}
});
test("new structured failure remains recoverable and late diagnostics preserve its cause",async()=>{
 const prep=await db.rpc("prepare_booking_card_removal_dispatch",{p_operation_id:op,p_attempt_token:attempt,p_provider:"square",p_merchant_id:"synthetic_merchant",p_environment:"sandbox"});expect(prep.error).toBeNull();expect(prep.data.ok).toBe(true);
 const r=await db.rpc("complete_booking_card_management_operation",{p_operation_id:op,p_attempt_token:attempt,p_outcome:"unknown",p_provider_reference:null,p_error_code:"removal_provider_write_failed"});expect(r.error).toBeNull();expect(r.data.code).toBe("remove_unknown");
 const before=await snapshot();expect((await record(diagnostic({p_provider:"square",p_stage:"database_completion",p_code:"removal_completion_uncertain",p_mutation_status:"not_proven"}))).ok).toBe(true);expect(await snapshot()).toEqual(before);
});

test("new failure code does not block valid receipt recovery or customer reload",async({browser})=>{
 const before=await snapshot();expect(before.error_code).toBe("removal_provider_write_failed");
 const args={p_token_id:token,p_request_id:requestId,p_card_fingerprint:fp};
 const context=await db.rpc("get_booking_card_removal_recovery_context",args);expect(context.error).toBeNull();expect(context.data.code).toBe("recovery_read_required");
 const complete=await db.rpc("complete_booking_card_removal_recovery",{...args,p_receipt:{operation_id:op,source_save_operation_id:null,source_removal_binding_id:op,
  card_id:card,customer_id:customer,merchant_id:"synthetic_merchant",environment:"sandbox",enabled:false,brand:"VISA",last4:"1111"}});
 expect(complete.error).toBeNull();expect(complete.data.ok).toBe(true);expect(await snapshot()).toEqual(before);
 const origin="https://nailiq-p0-signup-qa-20260911.vercel.app";const http=await request.newContext({baseURL:origin});await http.get(readFileSync(process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE!,"utf8").trim());
 const c=await browser.newContext({baseURL:origin,storageState:await http.storageState(),viewport:{width:390,height:844}});
 try{
  const page=await c.newPage();await page.goto("/booking/card");await expect(page.getByRole("heading",{name:"Your saved card"})).toBeVisible();
  const key="nailiq:booking-management-pending:"+createHash("sha256").update(JSON.stringify({v:1,action:"card_manage",token})).digest("hex");
  await page.evaluate(({key,value})=>sessionStorage.setItem(key,JSON.stringify(value)),{key,value:{requestId,material:fp,createdAt:Date.now()}});
  const response=page.waitForResponse(r=>r.url().includes("/api/booking/remove-card")&&r.request().method()==="POST");await page.goto(`/booking/card?token=${token}`);
  const r=await response;expect(r.status()).toBe(200);expect(await r.json()).toMatchObject({ok:true,code:"removed",idempotent:true});await expect(page.getByText("Card removed ✓",{exact:true})).toBeVisible();
  expect(await page.evaluate(key=>sessionStorage.getItem(key),key)).toBeNull();await page.screenshot({path:`${evidence}/structured-failure-recovered-mobile.png`,fullPage:true});expect(await snapshot()).toEqual(before);
 }finally{await c.close();await http.dispose();}
});
