import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
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
const card="ccof:synthetic_binding",customer="synthetic_customer",merchant="synthetic_merchant";
const staleMode = process.env.NAILIQ_OWNER_REMOVAL_STALE_QA;
const replacedLink = process.env.NAILIQ_OWNER_REMOVAL_REPLACED_LINK_QA === "1";
let replacementToken:string;
let token:string,requestId:string,fp:string,op:string,attempt:string;
function args(){return {p_token_id:token,p_request_id:requestId,p_card_fingerprint:fp};}
function proof(){return {operation_id:op,source_save_operation_id:null,source_removal_binding_id:op,
 card_id:card,customer_id:customer,merchant_id:merchant,environment:"sandbox",enabled:false,brand:"VISA",last4:"1111"};}
async function prep(extra={}){const r=await db.rpc("prepare_booking_card_removal_dispatch",{
 p_operation_id:op,p_attempt_token:attempt,p_provider:"square",p_merchant_id:merchant,p_environment:"sandbox",...extra});
 expect(r.error).toBeNull();return r.data;}
function receipt(){appendFileSync(`${evidence}/fixture-history.jsonl`,JSON.stringify({salons:fixtures.map(f=>({id:f.salonId,slug:f.slug})),users:users.map(u=>u.userId)})+"\n");}
test.beforeAll(async()=>{
 test.setTimeout(180000);
 for(const label of ["a","b"]){fixtures.push(await seedReceptionistCenterFixture(`e2e-p003-ownerremoval-${label}-${randomUUID()}`));receipt();}
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
 if(replacedLink){
  const newer=await db.rpc("mint_booking_management_capability",{p_salon_id:f.salonId,p_booking_id:f.displayApptBookingId,p_action:"card_manage",p_min_expires_at:new Date(Date.now()+1200000).toISOString()});
  expect(newer.error).toBeNull();expect(newer.data.ok).toBe(true);replacementToken=newer.data.token_id;expect(replacementToken).not.toBe(token);
  const old=await db.from("booking_management_capabilities").select("revoked_at,revoke_reason").eq("id",token).single();expect(old.error).toBeNull();expect(old.data?.revoke_reason).toBe("replaced_for_longer_expiry");expect(old.data?.revoked_at).toBeTruthy();
 }
 expect((await db.from("square_integrations").select("salon_id").eq("salon_id",f.salonId)).data).toEqual([]);
 if(!staleMode){
 const done=await db.rpc("complete_booking_card_management_operation",{p_operation_id:op,p_attempt_token:attempt,p_outcome:"unknown",p_provider_reference:null,p_error_code:"provider_exception"});
 expect(done.error).toBeNull();expect(done.data.code).toBe("remove_unknown");
 }
 users.push(await seedTestUser());receipt();
 expect((await db.from("salon_members").insert({salon_id:f.salonId,user_id:users[0].userId,role:"owner"})).error).toBeNull();
 expect((await db.from("booking_management_capabilities").update({expires_at:new Date(Date.now()-1000).toISOString()}).eq("id",token)).error).toBeNull();
 if(staleMode==="ui") await waitForStale();
});
test.afterAll(async()=>{for(const f of fixtures)await cleanupTestSalon(f.slug,{clearAllRateLimits:false});for(const u of users)await cleanupTestUser(u.userId);receipt();});
function ownerArgs(){return {p_salon_id:fixtures[0].salonId,p_operation_id:op,p_actor_id:users[0].userId};}
async function context(extra={}){const r=await db.rpc("get_owner_booking_card_removal_recovery_context",{...ownerArgs(),...extra});expect(r.error).toBeNull();return r.data;}
async function complete(value:unknown=proof()){const r=await db.rpc("complete_owner_booking_card_removal_recovery",{...ownerArgs(),p_receipt:value});expect(r.error).toBeNull();return r.data;}
async function role(value:string){expect((await db.from("salon_members").update({role:value}).eq("salon_id",fixtures[0].salonId).eq("user_id",users[0].userId)).error).toBeNull();}
async function prepareOwner(extra={}){const r=await db.rpc("prepare_owner_booking_card_removal_recovery",{...ownerArgs(),...extra});expect(r.error).toBeNull();return r.data;}
async function waitForStale(){const r=await db.from("booking_card_removal_dispatch_bindings").select("prepared_at").eq("operation_id",op).single();expect(r.error).toBeNull();await new Promise(resolve=>setTimeout(resolve,Math.max(0,new Date(r.data!.prepared_at).getTime()+122000-Date.now())));}
if(staleMode==="prepare") test("Owner quarantines stale sending once without renewing provider dispatch",async()=>{
 test.setTimeout(180000);
 const before=(await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data!;
 expect((await context()).ok).toBe(false);
 expect((await prepareOwner()).code).toBe("in_flight");
 for(const extra of [{p_actor_id:randomUUID()},{p_salon_id:fixtures[1].salonId}])expect((await prepareOwner(extra)).code).toBe("unauthorized");
 const cap=(await db.from("booking_management_capabilities").select("revoked_at,revoke_reason").eq("id",token).single()).data!;
 expect((await db.from("booking_management_capabilities").update({revoked_at:new Date().toISOString(),revoke_reason:"manual_revoke"}).eq("id",token)).error).toBeNull();
 expect((await prepareOwner()).code).toBe("expired_or_revoked");
 expect((await db.from("booking_management_capabilities").update(cap).eq("id",token)).error).toBeNull();
 expect((await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data).toEqual(before);
 await waitForStale();
 const r=await Promise.all([prepareOwner(),prepareOwner(),prepareOwner()]);expect(r.every(x=>x.ok&&x.code==="recovery_read_required")).toBe(true);
 const after=await db.from("booking_card_management_operations").select("status,error_code").eq("id",op).single();expect(after.error).toBeNull();expect(after.data).toEqual({status:"unknown",error_code:"removal_dispatch_outcome_uncertain"});
 const receipts=await db.from("booking_management_action_receipts").select("capability_id").eq("capability_id",token);expect(receipts.error).toBeNull();expect(receipts.data).toHaveLength(1);
 expect((await prep()).code).toBe("claim_mismatch");
 const late=await db.rpc("complete_booking_card_management_operation",{p_operation_id:op,p_attempt_token:attempt,p_outcome:"succeeded",p_provider_reference:card,p_error_code:null});expect(late.error).toBeNull();expect(late.data.code).toBe("completion_conflict");
});
if(replacedLink) test("completion preserves the replacement reason and immutable removal history",async()=>{
 const c=await db.from("booking_management_capabilities").select("revoke_reason,revoked_at").eq("id",token).single();expect(c.error).toBeNull();
 expect(c.data?.revoke_reason).toBe("replaced_for_longer_expiry");expect(c.data?.revoked_at).toBeTruthy();
});
test("expired customer link remains denied while current Owner/Admin can inspect original request",async()=>{
 const c=(await db.from("booking_management_capabilities").select("*").eq("id",token).single()).data;
 expect((await db.rpc("get_booking_card_removal_recovery_context",args())).data.code).toBe("expired_or_revoked");
 for(const r of ["owner","admin"]){await role(r);expect(await context()).toMatchObject({ok:true,code:"recovery_read_required",operation_id:op,source_removal_binding_id:op});}
 await role("owner");expect((await db.from("booking_management_capabilities").select("*").eq("id",token).single()).data).toEqual(c);
});
test("role changes and foreign salon or actor deny context and completion",async()=>{
 for(const r of ["senior","receptionist","nail_tech"]){await role(r);expect((await context()).code).toBe("unauthorized");expect((await complete()).code).toBe("unauthorized");}
 await role("owner");expect((await context({p_actor_id:randomUUID()})).code).toBe("unauthorized");expect((await context({p_salon_id:fixtures[1].salonId})).code).toBe("unauthorized");
 expect((await context({p_operation_id:randomUUID()})).code).toBe("invalid_request");
});
test("revocation stale epoch changed card and soft deletion are never bypassed",async()=>{
 const c=(await db.from("booking_management_capabilities").select("*").eq("id",token).single()).data!;
 expect((await db.from("booking_management_capabilities").update({revoked_at:new Date().toISOString(),revoke_reason:"manual_revoke"}).eq("id",token)).error).toBeNull();
 expect((await context()).code).toBe("expired_or_revoked");expect((await complete()).code).toBe("expired_or_revoked");
 expect((await db.from("booking_management_capabilities").update({revoked_at:c.revoked_at,revoke_reason:c.revoke_reason}).eq("id",token)).error).toBeNull();
 const state=(await db.from("booking_management_action_state").select("epoch").eq("booking_id",fixtures[0].displayApptBookingId).eq("action","card_manage").single()).data!;
 expect((await db.from("booking_management_action_state").update({epoch:state.epoch+1}).eq("booking_id",fixtures[0].displayApptBookingId).eq("action","card_manage")).error).toBeNull();
 expect((await context()).code).toBe("booking_state_changed");expect((await complete()).ok).toBe(false);
 expect((await db.from("booking_management_action_state").update({epoch:state.epoch}).eq("booking_id",fixtures[0].displayApptBookingId).eq("action","card_manage")).error).toBeNull();
 for(const change of [{noshow_card_id:"ccof:other"},{deleted_at:new Date().toISOString()},{noshow_charge_status:"charged"}]){
  expect((await db.from("bookings").update(change).eq("id",fixtures[0].displayApptBookingId)).error).toBeNull();
  expect((await context()).code).toBe("booking_state_changed");expect((await complete()).ok).toBe(false);
  expect((await db.from("bookings").update({noshow_card_id:card,deleted_at:null,noshow_charge_status:null}).eq("id",fixtures[0].displayApptBookingId)).error).toBeNull();
 }
});
if(replacedLink){
 test("replacement lineage, timing, and unchanged authority are required",async()=>{
  const original=(await db.from("booking_management_capabilities").select("*").eq("id",replacementToken).single()).data!;
  const before=(await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data!;
  for(const change of [{epoch:original.epoch+1},{card_state_fingerprint:"f".repeat(64)},
    {created_at:new Date(Date.now()-86400000).toISOString()},{created_at:new Date(Date.now()+86400000).toISOString()},
    {revoked_at:new Date().toISOString(),revoke_reason:"manual_revoke"},{consumed_at:new Date().toISOString(),request_id:randomUUID(),payload_fingerprint:"a".repeat(64),result_json:{ok:true},result_fingerprint:"b".repeat(64)}]){
   expect((await db.from("booking_management_capabilities").update(change).eq("id",replacementToken)).error).toBeNull();
   try{expect((await context()).code).toBe("expired_or_revoked");expect((await complete()).code).toBe("expired_or_revoked");}
   finally{const restore=Object.fromEntries(Object.keys(change).map(k=>[k,original[k]]));expect((await db.from("booking_management_capabilities").update(restore).eq("id",replacementToken)).error).toBeNull();}
  }
  expect((await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data).toEqual(before);
  expect((await context()).ok).toBe(true);
 });
 test("unknown historical revocation reasons never inherit replacement authority",async()=>{
  const c=(await db.from("booking_management_capabilities").select("revoke_reason,revoked_at").eq("id",token).single()).data!;
  for(const reason of ["action_consumed","manual_revoke","booking_changed","party_changed",null]){
   expect((await db.from("booking_management_capabilities").update({revoke_reason:reason}).eq("id",token)).error).toBeNull();
   try{expect((await context()).code).toBe("expired_or_revoked");expect((await complete()).code).toBe("expired_or_revoked");}
   finally{expect((await db.from("booking_management_capabilities").update(c).eq("id",token)).error).toBeNull();}
  }
 });
 test("replacement revocation between provider read and completion stops completion",async()=>{
  expect((await context()).ok).toBe(true);
  expect((await db.from("booking_management_capabilities").update({revoked_at:new Date().toISOString(),revoke_reason:"manual_revoke"}).eq("id",replacementToken)).error).toBeNull();
  try{expect((await complete()).code).toBe("expired_or_revoked");}
  finally{expect((await db.from("booking_management_capabilities").update({revoked_at:null,revoke_reason:null}).eq("id",replacementToken)).error).toBeNull();}
  expect((await db.from("bookings").select("noshow_card_id").eq("id",fixtures[0].displayApptBookingId).single()).data?.noshow_card_id).toBe(card);
 });
}
test("invalid active foreign and incomplete provider receipts cannot complete",async()=>{
 for(const receipt of [{...proof(),enabled:true},{...proof(),customer_id:"other"},{...proof(),merchant_id:"other"},{...proof(),last4:null},{...proof(),source_removal_binding_id:null}])expect((await complete(receipt)).code).toBe("invalid_recovery_receipt");
 expect((await db.from("booking_card_removal_recovery_receipts").select("operation_id").eq("operation_id",op)).data).toEqual([]);
});
test("browser roles cannot invoke service-only recovery RPCs",async()=>{
 const anon=createClient(qa,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
 expect((await anon.rpc("get_owner_booking_card_removal_recovery_context",ownerArgs())).error?.code).toBe("42501");
 expect((await anon.rpc("complete_owner_booking_card_removal_recovery",{...ownerArgs(),p_receipt:proof()})).error?.code).toBe("42501");
 const signed=createClient(qa,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
 expect((await signed.auth.signInWithPassword({email:users[0].email,password:users[0].password})).error).toBeNull();
 try{expect((await signed.rpc("get_owner_booking_card_removal_recovery_context",ownerArgs())).error?.code).toBe("42501");}finally{await signed.auth.signOut();}
});
function parseAction(text:string){const line=text.split("\n").find(l=>/^\w+:\{"ok":/.test(l));expect(line,"structured action result").toBeTruthy();return JSON.parse(line!.slice(line!.indexOf(":")+1));}
test("Owner desktop/mobile UI checks expired removal; role and tenant replay stay denied",async({browser})=>{
 test.skip(!process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE,"Preview access required");
 const origin="https://nailiq-p0-signup-qa-20260911.vercel.app";const jar=new Map<string,string>();
 const auth=createServerClient(qa,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{cookies:{getAll:()=>[...jar].map(([name,value])=>({name,value})),setAll:values=>{for(const v of values)jar.set(v.name,v.value);}}});
 expect((await auth.auth.signInWithPassword({email:users[0].email,password:users[0].password})).error).toBeNull();
 const http=await request.newContext({baseURL:origin,storageState:{origins:[],cookies:[...jar].map(([name,value])=>({name,value,domain:new URL(origin).hostname,path:"/",expires:-1,httpOnly:false,secure:true,sameSite:"Lax" as const}))}});
 await http.get(readFileSync(process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE!,"utf8").trim());
 const bc=await browser.newContext({storageState:await http.storageState(),viewport:{width:1280,height:900}});
 try{
  await bc.addInitScript(()=>{if(!localStorage.getItem("nailiq-user-lang"))localStorage.setItem("nailiq-user-lang","vi");});
  const page=await bc.newPage();const path=`/dashboard/${fixtures[0].slug}/no-show-protection`;await page.goto(origin+path);
  const section=page.getByTestId("owner-card-removal-exceptions");await expect(section).toBeVisible({timeout:45000});await expect(section.getByTestId("removal-exception")).toHaveCount(1);
  expect(await section.innerText()).not.toContain(card);expect(await section.innerText()).not.toContain(customer);
  const observed=page.waitForRequest(r=>!!r.headers()["next-action"]&&r.postData()===JSON.stringify([fixtures[0].slug,op]));
  await section.getByRole("button").click();const actionId=(await observed).headers()["next-action"];
  await expect(section.getByRole("status")).toBeVisible({timeout:30000});
  const events=await db.from("booking_card_removal_recovery_events").select("stage,code").eq("operation_id",op);expect(events.data).toContainEqual({stage:"configuration",code:"square_config_unavailable"});
  await expect(section.getByRole("heading",{name:"Yêu cầu gỡ thẻ"})).toBeVisible();
  await expect(section.getByRole("button")).toBeEnabled();
  await section.screenshot({path:`${evidence}/owner-removal-desktop.png`});
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>localStorage.setItem("nailiq-user-lang","en"));await page.reload();await expect(section.getByRole("heading",{name:"Card removal requests"})).toBeVisible();await section.screenshot({path:`${evidence}/owner-removal-mobile.png`});
  const invoke=async(slug=fixtures[0].slug)=>{
   const r=await bc.request.post(origin+path,{headers:{Origin:origin,"next-action":actionId,"content-type":"text/plain;charset=UTF-8",accept:"text/x-component"},data:JSON.stringify([slug,op]),maxRedirects:0});
   const red=r.headers()["x-action-redirect"];if(red||[303,307,308].includes(r.status()))return {ok:false,code:"unauthorized"};
   return parseAction(await r.text());
  };
  for(const r of ["senior","receptionist","nail_tech"]){await role(r);expect(await invoke()).toMatchObject({ok:false,code:"unauthorized"});}
  await role("owner");expect((await invoke(fixtures[1].slug)).ok).toBe(false);
  await role("admin");expect((await invoke()).code).toBe("remove_unknown");await role("owner");
  await auth.auth.signOut({scope:"global"});
  // Keep the Preview access cookie so the signed-out replay reaches NailIQ.
  await bc.clearCookies({name:/^sb-/});expect((await bc.cookies()).some(c=>c.name.startsWith("sb-"))).toBe(false);
  expect((await invoke()).ok).toBe(false);
 }finally{await auth.auth.signOut({scope:"global"});await bc.close();await http.dispose();await role("owner");}
});
test("Owner permission removed between read and receipt prevents completion",async()=>{
 expect((await context()).ok).toBe(true);await role("receptionist");expect((await complete()).code).toBe("unauthorized");await role("owner");
});
test("concurrent Owner completion writes one attributed receipt without renewing customer link",async()=>{
 const before=(await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data;
 const cap=(await db.from("booking_management_capabilities").select("*").eq("id",token).single()).data;
 const r=await Promise.all([complete(),complete(),complete()]);expect(r.every(x=>x.ok===true)).toBe(true);expect(r.filter(x=>x.idempotent===false)).toHaveLength(1);
 const receipt=await db.from("booking_card_removal_recovery_receipts").select("owner_actor_id,operation_id").eq("operation_id",op);expect(receipt.error).toBeNull();expect(receipt.data).toEqual([{owner_actor_id:users[0].userId,operation_id:op}]);
 expect((await db.from("booking_card_management_operations").select("*").eq("id",op).single()).data).toEqual(before);
 expect((await db.from("booking_management_capabilities").select("*").eq("id",token).single()).data).toEqual(cap);
 expect((await db.rpc("get_booking_card_removal_recovery_context",args())).data.code).toBe("expired_or_revoked");expect((await context()).code).toBe("removed");
 const open=await db.from("booking_card_management_operations").select("id,recovery:booking_card_removal_recovery_receipts(operation_id)").is("recovery",null).eq("id",op);expect(open.error).toBeNull();expect(open.data).toEqual([]);
});
