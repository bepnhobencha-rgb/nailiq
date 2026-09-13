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
 for(const label of ["a","b"]){fixtures.push(await seedReceptionistCenterFixture(`e2e-p003-removalbinding-${label}-${randomUUID()}`));receipt();}
 const f=fixtures[0];const start=Date.now()+14*86400000;
 expect((await db.from("bookings").update({status:"confirmed",start_time_utc:new Date(start).toISOString(),end_time_utc:new Date(start+3600000).toISOString(),
 noshow_card_id:card,noshow_customer_id:customer,noshow_card_brand:"VISA",noshow_card_last4:"1111",noshow_charge_status:null})
 .eq("id",f.displayApptBookingId).eq("salon_id",f.salonId)).error).toBeNull();
 const mint=await db.rpc("mint_booking_management_capability",{p_salon_id:f.salonId,p_booking_id:f.displayApptBookingId,p_action:"card_manage",p_min_expires_at:new Date(Date.now()+600000).toISOString()});
 expect(mint.error).toBeNull();expect(mint.data.ok,String(mint.data.code)).toBe(true);token=mint.data.token_id;requestId=randomUUID();
 const c=await db.from("booking_management_capabilities").select("card_state_fingerprint").eq("id",token).single();expect(c.error).toBeNull();fp=c.data!.card_state_fingerprint;
 const claim=await db.rpc("claim_booking_card_management_operation",{p_token_id:token,p_request_id:requestId,p_expected_card_fingerprint:fp});
 expect(claim.error).toBeNull();expect(claim.data.code).toBe("claimed");op=claim.data.operation_id;attempt=claim.data.attempt_token;
});
test.afterAll(async()=>{for(const f of fixtures)await cleanupTestSalon(f.slug,{clearAllRateLimits:false});receipt();});
test("invalid identity or attempt does not prepare",async()=>{
 for(const extra of [{p_merchant_id:null},{p_environment:null},{p_environment:"invalid"},{p_merchant_id:"invalid space"}])expect((await prep(extra)).ok).toBe(false);
 expect((await prep({p_attempt_token:randomUUID()})).code).toBe("claim_mismatch");
 const r=await db.from("booking_card_removal_dispatch_bindings").select("operation_id").eq("operation_id",op);expect(r.error).toBeNull();expect(r.data).toEqual([]);
});
test("concurrent claims retain one operation and reject a different request or fingerprint",async()=>{
 const claimArgs={p_token_id:token,p_request_id:requestId,p_expected_card_fingerprint:fp};
 const claims=await Promise.all(Array.from({length:5},()=>db.rpc("claim_booking_card_management_operation",claimArgs)));
 for(const r of claims){expect(r.error).toBeNull();expect(r.data).toMatchObject({code:"claimed",operation_id:op,attempt_token:attempt,attempt_replay:true});}
 for(const change of [{p_request_id:randomUUID()},{p_expected_card_fingerprint:"f".repeat(64)}]){
  const r=await db.rpc("claim_booking_card_management_operation",{...claimArgs,...change});expect(r.error).toBeNull();expect(r.data.code).toBe("idempotency_mismatch");
 }
 const operations=await db.from("booking_card_management_operations").select("id").eq("capability_id",token);
 expect(operations.error).toBeNull();expect(operations.data).toEqual([{id:op}]);
});
test("concurrent preparation authorizes only one caller and preserves original material",async()=>{
 const before=(await db.from("booking_card_management_operations").select("provider_material").eq("id",op).single()).data;
 const r=await Promise.all([prep(),prep(),prep()]);expect(r.filter(x=>x.ok===true)).toHaveLength(1);expect(r.filter(x=>x.code==="removal_dispatch_in_progress")).toHaveLength(2);
 const rows=await db.from("booking_card_removal_dispatch_bindings").select("*").eq("operation_id",op);expect(rows.error).toBeNull();expect(rows.data).toHaveLength(1);
 expect(rows.data![0]).toMatchObject({salon_id:fixtures[0].salonId,booking_id:fixtures[0].displayApptBookingId,provider:"square",card_id:card,customer_id:customer,merchant_id:merchant,environment:"sandbox"});
 expect((await db.from("booking_card_management_operations").select("provider_material").eq("id",op).single()).data).toEqual(before);
});
test("account environment and provider drift cannot overwrite a frozen binding",async()=>{
 const r=await Promise.all([prep(),prep({p_merchant_id:"other"}),prep({p_environment:"production"}),prep({p_provider:"stripe",p_merchant_id:null,p_environment:null})]);
 expect(r[0]).toMatchObject({ok:false,code:"removal_dispatch_in_progress"});expect(r.slice(1).every(x=>x.code==="removal_provider_mismatch")).toBe(true);
});
test("expired revoked and stale epoch block replay preparation",async()=>{
 const old=(await db.from("booking_management_capabilities").select("expires_at,epoch").eq("id",token).single()).data!;
 for(const change of [{expires_at:new Date(Date.now()-1000).toISOString()},{revoked_at:new Date().toISOString(),revoke_reason:"manual_revoke"}]){
  expect((await db.from("booking_management_capabilities").update(change).eq("id",token)).error).toBeNull();
  try{expect((await prep()).code).toBe("expired_or_revoked");}finally{await db.from("booking_management_capabilities").update({expires_at:old.expires_at,revoked_at:null,revoke_reason:null}).eq("id",token);}
 }
 await db.from("booking_management_action_state").update({epoch:old.epoch+1}).eq("booking_id",fixtures[0].displayApptBookingId).eq("action","card_manage");
 try{expect((await prep()).code).toBe("booking_state_changed");}finally{await db.from("booking_management_action_state").update({epoch:old.epoch}).eq("booking_id",fixtures[0].displayApptBookingId).eq("action","card_manage");}
});
test("direct API cannot create rewrite or read the binding",async()=>{
 const anon=createClient(qa,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
 expect((await anon.from("booking_card_removal_dispatch_bindings").select("*")).error?.code).toBe("42501");
 expect((await anon.rpc("prepare_booking_card_removal_dispatch",{p_operation_id:op,p_attempt_token:attempt,p_provider:"square",p_merchant_id:merchant,p_environment:"sandbox"})).error?.code).toBe("42501");
 expect((await db.from("booking_card_removal_dispatch_bindings").update({salon_id:fixtures[1].salonId}).eq("operation_id",op)).error?.code).toBe("42501");
});
test("stale authorization becomes unknown once and never grants another dispatch",async()=>{
 test.setTimeout(160000);
 const before=await db.from("booking_card_removal_dispatch_bindings").select("prepared_at").eq("operation_id",op).single();expect(before.error).toBeNull();
 const remaining=Math.max(0,new Date(before.data!.prepared_at).getTime()+122000-Date.now());
 await new Promise(resolve=>setTimeout(resolve,remaining));
 const r=await Promise.all([prep(),prep(),prep()]);
 expect(r.filter(x=>x.code==="remove_unknown")).toHaveLength(1);
 expect(r.filter(x=>x.code==="claim_mismatch")).toHaveLength(2);
 expect(r.every(x=>x.ok===false)).toBe(true);
 const state=await db.from("booking_card_management_operations").select("status,error_code").eq("id",op).single();expect(state.error).toBeNull();
 expect(state.data).toEqual({status:"unknown",error_code:"removal_dispatch_outcome_uncertain"});
 const old=await db.rpc("complete_booking_card_management_operation",{p_operation_id:op,p_attempt_token:attempt,p_outcome:"succeeded",p_provider_reference:card,p_error_code:null});
 expect(old.error).toBeNull();expect(old.data.code).toBe("completion_conflict");
 const booking=await db.from("bookings").select("noshow_card_id,status").eq("id",fixtures[0].displayApptBookingId).single();
 expect(booking.error).toBeNull();expect(booking.data).toEqual({noshow_card_id:card,status:"confirmed"});
});
test("unknown operation without historical save receipt can use its frozen identity",async()=>{
 expect((await prep()).code).toBe("claim_mismatch");
 const ctx=await db.rpc("get_booking_card_removal_recovery_context",args());expect(ctx.error).toBeNull();
 expect(ctx.data).toMatchObject({ok:true,code:"recovery_read_required",source_save_operation_id:null,source_removal_binding_id:op,merchant_id:merchant});
 const saves=await db.from("booking_card_save_operations").select("id").eq("booking_id",fixtures[0].displayApptBookingId);expect(saves.data).toEqual([]);
});
test("recovery rejects absent ambiguous wrong source and invalid card state",async()=>{
 for(const value of [{...proof(),source_removal_binding_id:null},{...proof(),source_removal_binding_id:randomUUID()},
 {...proof(),source_save_operation_id:randomUUID()},{...proof(),enabled:true},{...proof(),merchant_id:"other"},{...proof(),last4:null}])expect((await recover(value)).code).toBe("invalid_recovery_receipt");
});
test("concurrent recovery stores one receipt without changing original unknown error",async()=>{
 const before=(await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data;
 const r=await Promise.all([recover(),recover(),recover()]);expect(r.every(x=>x.ok===true)).toBe(true);expect(r.filter(x=>x.idempotent===false)).toHaveLength(1);
 expect((await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data).toEqual(before);
 const receipts=await db.from("booking_card_removal_recovery_receipts").select("source_save_operation_id,source_removal_binding_id").eq("operation_id",op);expect(receipts.error).toBeNull();expect(receipts.data).toEqual([{source_save_operation_id:null,source_removal_binding_id:op}]);
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
  expect((await db.from("booking_card_management_operations").select("status,error_code").eq("id",op).single()).data).toEqual({status:"unknown",error_code:"removal_dispatch_outcome_uncertain"});
 }finally{await c.close();await http.dispose();}
});

test("renewing the link while the first removal is sending cannot authorize a second operation",async()=>{
 const f=fixtures[1];
 expect((await db.from("bookings").update({noshow_card_id:card,noshow_customer_id:customer,noshow_charge_status:null}).eq("id",f.displayApptBookingId).eq("salon_id",f.salonId)).error).toBeNull();
 async function mintClaim(minutes:number){
  const mint=await db.rpc("mint_booking_management_capability",{p_salon_id:f.salonId,p_booking_id:f.displayApptBookingId,p_action:"card_manage",p_min_expires_at:new Date(Date.now()+minutes*60000).toISOString()});
  expect(mint.error).toBeNull();expect(mint.data.ok).toBe(true);
  const cap=await db.from("booking_management_capabilities").select("card_state_fingerprint").eq("id",mint.data.token_id).single();expect(cap.error).toBeNull();
  const claim=await db.rpc("claim_booking_card_management_operation",{p_token_id:mint.data.token_id,p_request_id:randomUUID(),p_expected_card_fingerprint:cap.data!.card_state_fingerprint});
  expect(claim.error).toBeNull();expect(claim.data.code).toBe("claimed");return claim.data;
 }
 async function prepare(c:{operation_id:string;attempt_token:string}){
  const r=await db.rpc("prepare_booking_card_removal_dispatch",{p_operation_id:c.operation_id,p_attempt_token:c.attempt_token,p_provider:"square",p_merchant_id:merchant,p_environment:"sandbox"});
  expect(r.error).toBeNull();return r.data;
 }
 const first=await mintClaim(5);expect((await prepare(first)).ok).toBe(true);
 const replacement=await mintClaim(20);expect(replacement.operation_id).not.toBe(first.operation_id);
 expect(await prepare(replacement)).toMatchObject({ok:false,code:"removal_dispatch_in_progress"});
 const bindings=await db.from("booking_card_removal_dispatch_bindings").select("operation_id").eq("booking_id",f.displayApptBookingId);
 expect(bindings.error).toBeNull();expect(bindings.data).toEqual([{operation_id:first.operation_id}]);
});
