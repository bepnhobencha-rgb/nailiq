import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash,randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

// Opt-in disposable DB integration. Normal unit runs skip this file. Provider
// transport is simulated; this is deliberately not claimed as Square Sandbox.
const control = vi.hoisted(() => ({ configFailure:false }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider:async () => {
  if (control.configFailure) throw new Error("PRIVATE_CONFIG_DETAIL");
  const { SquareProvider } = await import("@/shared/integrations/payments/square");
  return new SquareProvider(cfg);
} }));
vi.mock("@/shared/integrations/square/client", async (original) => ({
  ...await original<typeof import("@/shared/integrations/square/client")>(), getSquareConfig:async () => {
    if (control.configFailure) throw new Error("PRIVATE_CONFIG_DETAIL");
    return cfg;
  },
}));
import { saveCardWithManagementCapability } from "../bookingCardManagement";
import { reconcileBookingCardSaveOperations } from "../reconcileBookingCardSaveOperations";
import type { SquareConfig } from "@/shared/integrations/square/client";

const enabled = process.env.NAILIQ_CARD_TRUTH_DISPOSABLE_QA === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55631";
const dbUrl = process.env.DB_URL ?? "";
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "unused-qa-key", { auth:{persistSession:false,autoRefreshToken:false} });
const salon = "55630000-0000-4000-8000-000000000010";
const service = "55630000-0000-4000-8000-000000000011";
const staff = "55630000-0000-4000-8000-000000000012";
const cfg: SquareConfig = { salonId:salon,merchantId:"merchant_qa",locationId:"location_qa",applicationId:"sandbox-qa",
  environment:"sandbox",currency:"CAD",accessToken:"PRIVATE_FAKE_KEY",sync:{pullCreate:false,pullUpdate:false,pullCancel:false,pushCreate:false,pushUpdate:false,pushCancel:false} };
const nativeFetch = globalThis.fetch;
function sql(query:string) {
  if (!enabled || url !== "http://127.0.0.1:55631" || new URL(dbUrl).hostname !== "127.0.0.1" || new URL(dbUrl).port !== "55632") throw new Error("disposable_qa_only");
  try { return execFileSync("/opt/homebrew/bin/psql",[dbUrl,"-X","-qAt","-v","ON_ERROR_STOP=1","-c",query],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim(); }
  catch { throw new Error("qa_sql_failed"); }
}
async function rpc(name:string,args:Record<string,unknown>) {
  const { data,error }=await db.rpc(name,args); if(error) throw new Error(`qa_rpc_${name}_${error.code}`); return data;
}
let sequence=0;
async function fixture(contact?: { phone?:string|null;email?:string|null;name?:string }) {
  const booking=randomUUID();
  sequence+=1;
  const phone=contact?.phone === undefined ? `+1604555${String(1000+sequence).padStart(4,"0")}` : contact.phone;
  const email=contact?.email === undefined ? "synthetic@example.test" : contact.email;
  const literal=(value:string|null)=>value === null ? "NULL" : `'${value.replace(/'/g,"''")}'`;
  sql(`INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,client_email,start_time_utc,end_time_utc,status,price_cents,noshow_card_required,noshow_fee_cents)
    VALUES('${booking}','${salon}','${service}','${staff}',${literal(contact?.name??"Synthetic Delivery")},${literal(phone)},${literal(email)},
    date_trunc('hour',now())+interval '3 days'+interval '${sequence} hours',date_trunc('hour',now())+interval '3 days'+interval '${sequence} hours 30 minutes','confirmed',5000,true,1000);`);
  const cap=await rpc("mint_booking_management_capability",{p_salon_id:salon,p_booking_id:booking,p_action:"card_manage",p_min_expires_at:new Date(Date.now()+25*60_000).toISOString()});
  expect(cap.ok).toBe(true);
  return { booking,tokenId:cap.token_id as string,requestId:randomUUID(),provider:"square" as const,sourceToken:"PRIVATE_FAKE_SOURCE" };
}
async function operation(booking:string) {
  const {data,error}=await db.from("booking_card_save_operations").select("*").eq("booking_id",booking).order("created_at",{ascending:false}).limit(1).single();
  expect(error).toBeNull();return data!;
}
async function bookingState(booking:string) {
  const {data,error}=await db.from("bookings").select("status,card_protection_status,noshow_card_id,noshow_customer_id,noshow_card_brand,noshow_card_last4,noshow_consent_at,noshow_consent_meta").eq("id",booking).single();
  expect(error).toBeNull();return data!;
}
function due(id:string) {
  sql(`UPDATE public.booking_card_save_operations SET created_at=now()-interval '21 minutes',consent_at=now()-interval '20 minutes',dispatch_prepared_at=now()-interval '20 minutes',next_reconcile_at=now()-interval '1 minute',reconciliation_lease_expires_at=NULL WHERE id='${id}';`);
}
type Mode="success"|"decline"|"search_timeout"|"customer_timeout"|"response_loss"|"invalid_receipt"|"db_before"|"db_after";
function transport(mode:Mode) {
  const calls:{path:string;method:string}[]=[];
  const customerRequests:{key:string;bodyHash:string}[]=[];
  let readCards:unknown[]=[]; let completionLost=false;let customerReferenceHit=false;let customerPhoneHit=false;let customerRecovery=false;
  vi.stubGlobal("fetch",async(input:RequestInfo|URL,init?:RequestInit)=>{
    const address=typeof input==="string"?input:input instanceof URL?input.href:input.url;
    const u=new URL(address);const method=init?.method??"GET";
    if(u.origin==="http://127.0.0.1:55631") {
      if(u.pathname.endsWith("/rpc/complete_booking_card_save_operation") && !completionLost && mode.startsWith("db_")) {
        completionLost=true;
        if(mode==="db_after") await nativeFetch(input,init);
        throw new TypeError("PRIVATE_DB_RESPONSE_LOST");
      }
      return nativeFetch(input,init);
    }
    if(u.origin!=="https://connect.squareupsandbox.com") throw new Error("network_boundary_denied");
    calls.push({path:u.pathname+u.search,method});
    const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
    if(u.pathname==="/v2/customers/search") {
      if(mode==="search_timeout") throw new TypeError("PRIVATE_PHONE PRIVATE_EMAIL");
      const filter=JSON.parse(String(init?.body)).query?.filter;
      const reference=filter?.reference_id?.exact;
      if(filter?.phone_number && customerPhoneHit) return response({customers:[{id:"customer_qa"}]});
      if(reference && customerReferenceHit) return response({customers:[{id:"customer_qa",reference_id:reference}]});
      return response({customers:[]});
    }
    if(u.pathname==="/v2/customers" && method==="POST") {
      const body=String(init?.body);customerRequests.push({key:JSON.parse(body).idempotency_key,bodyHash:createHash("sha256").update(body).digest("hex")});
      if(mode==="customer_timeout"&&!customerRecovery) throw new TypeError("PRIVATE_CUSTOMER_LOSS");
      return response({customer:{id:"customer_qa"}});
    }
    if(u.pathname==="/v2/cards" && method==="POST") {
      if(mode==="decline") return response({errors:[{category:"PAYMENT_METHOD_ERROR",code:"CARD_DECLINED",detail:"PRIVATE_CARD_DETAIL"}]},400);
      const body=JSON.parse(String(init?.body));
      const card={id:"card_qa",customer_id:"customer_qa",merchant_id:"merchant_qa",reference_id:body.card.reference_id,enabled:true,card_brand:"VISA",last_4:"4242"};
      readCards=[card];
      if(mode==="response_loss") throw new TypeError("PRIVATE_PROVIDER_LOSS");
      return response({card:mode==="invalid_receipt"?{...card,last_4:null}:card});
    }
    if(u.pathname==="/v2/cards" && method==="GET" && u.searchParams.has("reference_id")) return response({cards:readCards});
    throw new Error("unapproved_provider_route");
  });
  return {calls,customerRequests,setCards:(cards:unknown[])=>{readCards=cards;},getCards:()=>readCards,setCustomerReferenceHit:()=>{customerReferenceHit=true;},setCustomerPhoneHit:()=>{customerPhoneHit=true;},recoverCustomerCreate:()=>{customerRecovery=true;}};
}
afterEach(()=>{vi.unstubAllGlobals();control.configFailure=false;});
describe.skipIf(!enabled)("Disposable PostgreSQL + real operation helpers + simulated Square transport",()=>{
  beforeAll(()=>{
    sequence=Number(sql(`SELECT count(*) FROM public.bookings WHERE salon_id='${salon}'`));
    sql(`INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('card-delivery-integration','QA','QA') ON CONFLICT DO NOTHING;
      INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,profile_complete,noshow_protection_enabled,cancellation_policy)
      VALUES('${salon}','card-delivery-integration','Synthetic Card Delivery','+16045550100','America/Vancouver','CAD',true,true,'{"en":"Cancel with 24 hours notice.","vi":"Báo trước 24 giờ khi hủy."}') ON CONFLICT DO NOTHING;
      INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category) VALUES('${service}','${salon}','QA Service',5000,30,'card-delivery-integration') ON CONFLICT DO NOTHING;
      INSERT INTO public.staff(id,salon_id,name,status) VALUES('${staff}','${salon}','QA Staff','active') ON CONFLICT DO NOTHING;`);
  });
  it("commits complete receipt and consent; 20 racing requests create exactly one card",async()=>{
    const f=await fixture();const network=transport("success");
    const results=await Promise.all(Array.from({length:20},()=>saveCardWithManagementCapability(f)));
    expect(results.some(r=>r.ok)).toBe(true);
    expect(network.calls.filter(c=>c.path==="/v2/cards"&&c.method==="POST")).toHaveLength(1);
    expect(network.calls.filter(c=>c.path==="/v2/customers"&&c.method==="POST")).toHaveLength(1);
    expect(sql(`SELECT count(*) FROM public.booking_card_save_operations WHERE booking_id='${f.booking}'`)).toBe("1");
    const state=await bookingState(f.booking);expect(state).toMatchObject({status:"confirmed",card_protection_status:"saved",noshow_card_id:"card_qa",noshow_customer_id:"customer_qa",noshow_card_brand:"VISA",noshow_card_last4:"4242"});
    expect(state.noshow_consent_at).toBeTruthy();expect(state.noshow_consent_meta.policyVersion).toMatch(/^nsp_[a-f0-9]{64}$/);
    expect((await operation(f.booking)).status).toBe("succeeded");
  });
  it("two independent bookings for the same canonical contact create only one customer",async()=>{
    const contact=`+1604555${String(2000+sequence).padStart(4,"0")}`;
    const first=await fixture({phone:contact,name:"Synthetic First",email:"first@example.test"});
    const second=await fixture({phone:contact.slice(2),name:"Synthetic Later",email:"later@example.test"});
    const network=transport("success");
    const outcomes=await Promise.all([saveCardWithManagementCapability(first),saveCardWithManagementCapability(second)]);
    for(const [index,item] of [first,second].entries()) {
      if(outcomes[index].ok) continue;
      expect((await operation(item.booking)).status).toBe("failed");
      const cap=await rpc("recover_booking_card_management",{p_token_id:item.tokenId});
      expect(cap.ok).toBe(true);
      expect((await saveCardWithManagementCapability({...item,tokenId:cap.token_id,requestId:randomUUID(),sourceToken:"PRIVATE_FRESH_SOURCE"})).ok).toBe(true);
    }
    const one=await operation(first.booking);const two=await operation(second.booking);
    expect(one.customer_claim_id).toBeTruthy();expect(two.customer_claim_id).toBe(one.customer_claim_id);
    expect(network.calls.filter(c=>c.path==="/v2/customers"&&c.method==="POST")).toHaveLength(1);
    expect(network.calls.filter(c=>c.path==="/v2/cards"&&c.method==="POST")).toHaveLength(2);
    expect((await bookingState(first.booking)).noshow_customer_id).toBe((await bookingState(second.booking)).noshow_customer_id);
  });
  it("customer response loss fences a second booking until the shared reference resolves",async()=>{
    const phone=`+1604555${String(3000+sequence).padStart(4,"0")}`;
    const first=await fixture({phone});const second=await fixture({phone,name:"Synthetic Follower"});
    const network=transport("customer_timeout");
    expect((await saveCardWithManagementCapability(first)).ok).toBe(false);
    const prior=await operation(first.booking);
    expect(prior.status).toBe("unknown");expect(prior.customer_claim_id).toBeTruthy();
    expect((await saveCardWithManagementCapability(second)).ok).toBe(false);
    expect((await operation(second.booking)).status).toBe("failed");
    expect(network.calls.filter(c=>c.path==="/v2/customers"&&c.method==="POST")).toHaveLength(1);
    expect(network.calls.filter(c=>c.path==="/v2/cards"&&c.method==="POST")).toHaveLength(0);
    sql(`UPDATE public.square_card_customer_claims SET next_read_at=now()-interval '1 minute' WHERE id='${prior.customer_claim_id}';`);
    network.setCustomerReferenceHit();
    const cap=await rpc("recover_booking_card_management",{p_token_id:second.tokenId});
    expect((await saveCardWithManagementCapability({...second,tokenId:cap.token_id,requestId:randomUUID(),sourceToken:"PRIVATE_FRESH_SOURCE"})).ok).toBe(true);
    expect(network.calls.filter(c=>c.path==="/v2/customers"&&c.method==="POST")).toHaveLength(1);
    expect((await bookingState(second.booking)).card_protection_status).toBe("saved");
  });
  it("customer empty-read exhaustion preserves the exact first key/body and rejects a stale lease",async()=>{
    const phone=`+1604555${String(6000+sequence).padStart(4,"0")}`;
    const first=await fixture({phone,name:"Synthetic Initial",email:"initial@example.test"});
    const follower=await fixture({phone,name:"Synthetic Changed",email:"changed@example.test"});
    const network=transport("customer_timeout");
    expect((await saveCardWithManagementCapability(first)).ok).toBe(false);
    const prior=await operation(first.booking);const claimId=prior.customer_claim_id as string;
    expect((await saveCardWithManagementCapability(follower)).ok).toBe(false);
    expect(network.customerRequests).toHaveLength(1);
    expect(sql("SELECT has_function_privilege('authenticated','public.claim_square_card_customer(uuid,uuid)','EXECUTE')")).toBe("f");
    expect(sql("SELECT has_table_privilege('authenticated','public.square_card_customer_claims','SELECT')")).toBe("f");
    const stale=randomUUID();
    sql(`UPDATE public.square_card_customer_claims SET lease_token='${stale}',lease_expires_at=now()-interval '1 minute' WHERE id='${claimId}';`);
    const rejected=await rpc("complete_square_card_customer",{p_operation_id:prior.id,p_attempt_token:prior.attempt_token,
      p_claim_id:claimId,p_lease_token:stale,p_outcome:"found",p_customer_id:"customer_qa"});
    expect(rejected.ok).toBe(false);
    expect(sql(`SELECT status FROM public.square_card_customer_claims WHERE id='${claimId}'`)).toBe("unknown");
    let token=follower.tokenId;
    for(let i=0;i<3;i++) {
      sql(`UPDATE public.square_card_customer_claims SET lease_token=NULL,lease_expires_at=NULL,next_read_at=now()-interval '1 minute',
        dispatch_prepared_at=now()-interval '20 minutes' WHERE id='${claimId}';`);
      const cap=await rpc("recover_booking_card_management",{p_token_id:token});expect(cap.ok).toBe(true);token=cap.token_id;
      expect((await saveCardWithManagementCapability({...follower,tokenId:token,requestId:randomUUID(),sourceToken:"PRIVATE_FRESH_SOURCE"})).ok).toBe(false);
      expect(network.customerRequests).toHaveLength(1);
      expect(sql(`SELECT empty_read_count||'|'||status FROM public.square_card_customer_claims WHERE id='${claimId}'`)).toBe(`${i+1}|${i===2?"ready":"unknown"}`);
    }
    network.recoverCustomerCreate();
    const cap=await rpc("recover_booking_card_management",{p_token_id:token});expect(cap.ok).toBe(true);
    expect((await saveCardWithManagementCapability({...follower,tokenId:cap.token_id,requestId:randomUUID(),sourceToken:"PRIVATE_NEW_CARD_SOURCE"})).ok).toBe(true);
    expect(network.customerRequests).toHaveLength(2);
    expect(network.customerRequests[1]).toEqual(network.customerRequests[0]);
    expect((await bookingState(follower.booking)).card_protection_status).toBe("saved");
  });
  it("adopts an unresolved legacy customer key/reference and never creates under a new key",async()=>{
    const phone=`+1604555${String(4000+sequence).padStart(4,"0")}`;
    const first=await fixture({phone});const second=await fixture({phone});
    const old=await rpc("claim_booking_card_save_operation",{p_token_id:first.tokenId,p_request_id:first.requestId,p_provider:"square",p_mode:"save_card",p_source_fingerprint:"a".repeat(64)});
    await rpc("prepare_booking_card_save_dispatch",{p_operation_id:old.operation_id,p_attempt_token:old.attempt_token,p_consent_at:new Date().toISOString(),
      p_consent_meta:{v:2,policyVersion:`nsp_${"a".repeat(64)}`,scope:"booking_member",feeCents:1000,currency:"CAD",policyEn:"Synthetic policy",policyVi:"Synthetic policy"}});
    sql(`UPDATE public.booking_card_save_operations SET delivery_version=NULL,provider_material=provider_material-'customer_idempotency_key' WHERE id='${old.operation_id}';`);
    await rpc("complete_booking_card_save_operation",{p_operation_id:old.operation_id,p_attempt_token:old.attempt_token,p_outcome:"unknown",
      p_provider_reference:null,p_card_id:null,p_customer_id:null,p_card_brand:null,p_card_last4:null,p_consent_at:null,p_consent_meta:null,p_error_code:"provider_exception"});
    const network=transport("success");
    expect((await saveCardWithManagementCapability(second)).ok).toBe(false);
    const current=await operation(second.booking);
    expect(sql(`SELECT idempotency_key||'|'||reference_id FROM public.square_card_customer_claims WHERE id='${current.customer_claim_id}'`))
      .toBe(`${old.operation_id}:customer|booking:${first.booking}`);
    expect(network.calls.filter(c=>c.path==="/v2/customers"&&c.method==="POST")).toHaveLength(0);
    expect(network.calls.filter(c=>c.path==="/v2/cards"&&c.method==="POST")).toHaveLength(0);
  });
  it("repeated successful legacy appointments allow an exact customer read instead of a permanent fence",async()=>{
    const phone=`+1604555${String(5000+sequence).padStart(4,"0")}`;
    const consent={v:2,policyVersion:`nsp_${"a".repeat(64)}`,scope:"booking_member",feeCents:1000,currency:"CAD",policyEn:"Synthetic policy",policyVi:"Synthetic policy"};
    for(let i=0;i<2;i++) {
      const old=await fixture({phone});
      const claim=await rpc("claim_booking_card_save_operation",{p_token_id:old.tokenId,p_request_id:old.requestId,p_provider:"square",p_mode:"save_card",p_source_fingerprint:"a".repeat(64)});
      const at=new Date().toISOString();
      await rpc("prepare_booking_card_save_dispatch",{p_operation_id:claim.operation_id,p_attempt_token:claim.attempt_token,p_consent_at:at,p_consent_meta:consent});
      await rpc("bind_booking_card_save_dispatch",{p_operation_id:claim.operation_id,p_attempt_token:claim.attempt_token,p_customer_id:"customer_qa",p_merchant_id:cfg.merchantId,p_environment:cfg.environment});
      const completed=await rpc("complete_booking_card_save_operation",{p_operation_id:claim.operation_id,p_attempt_token:claim.attempt_token,p_outcome:"succeeded",
        p_provider_reference:`card_legacy_${i}`,p_card_id:`card_legacy_${i}`,p_customer_id:"customer_qa",p_card_brand:"VISA",p_card_last4:"4242",p_consent_at:at,p_consent_meta:consent,p_error_code:null});
      expect(completed.ok).toBe(true);
      sql(`UPDATE public.booking_card_save_operations SET delivery_version=NULL,expected_customer_id=NULL,expected_merchant_id=NULL,expected_environment=NULL,
        provider_material=provider_material-'customer_idempotency_key' WHERE id='${claim.operation_id}';`);
    }
    const fresh=await fixture({phone});const network=transport("success");network.setCustomerPhoneHit();
    expect((await saveCardWithManagementCapability(fresh)).ok).toBe(true);
    expect(network.calls.filter(c=>c.path==="/v2/customers"&&c.method==="POST")).toHaveLength(0);
    expect((await bookingState(fresh.booking)).card_protection_status).toBe("saved");
  });
  it("normalizes email-only identity and never merges anonymous bookings by name",async()=>{
    const email=`synthetic-${randomUUID()}@example.test`;
    const first=await fixture({phone:null,email});const second=await fixture({phone:null,email:email.toUpperCase()});
    const network=transport("success");
    expect((await saveCardWithManagementCapability(first)).ok).toBe(true);
    expect((await saveCardWithManagementCapability(second)).ok).toBe(true);
    expect((await operation(first.booking)).customer_claim_id).toBe((await operation(second.booking)).customer_claim_id);
    expect(network.calls.filter(c=>c.path==="/v2/customers"&&c.method==="POST")).toHaveLength(1);
    const third=await fixture({phone:null,email:null,name:"Synthetic Same"});const fourth=await fixture({phone:null,email:null,name:"Synthetic Same"});
    expect((await saveCardWithManagementCapability(third)).ok).toBe(true);
    expect((await saveCardWithManagementCapability(fourth)).ok).toBe(true);
    expect((await operation(third.booking)).customer_claim_id).not.toBe((await operation(fourth.booking)).customer_claim_id);
  });
  it.each(["decline","search_timeout","customer_timeout","response_loss","invalid_receipt"] as const)("stages %s without exposing secrets or inventing protection",async(mode)=>{
    const f=await fixture();const network=transport(mode);
    expect((await saveCardWithManagementCapability(f)).ok).toBe(false);
    const op=await operation(f.booking);const state=await bookingState(f.booking);
    expect(state.status).toBe("confirmed");expect(state.card_protection_status).not.toBe("saved");expect(state.noshow_card_id).toBeNull();
    expect(op.first_failure_stage).toBe({decline:"card_create",search_timeout:"customer_search",customer_timeout:"customer_create",response_loss:"card_create",invalid_receipt:"receipt_validation"}[mode]);
    const {data:events}=await db.from("booking_card_delivery_events").select("*").eq("operation_id",op.id);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|synthetic@|1604555/);
    const before=network.calls.length;await saveCardWithManagementCapability(f);expect(network.calls.length).toBe(before);
    if(mode==="search_timeout") expect(network.calls.some(c=>c.path==="/v2/customers"||c.path==="/v2/cards")).toBe(false);
    if(mode==="customer_timeout") expect(network.calls.some(c=>c.path==="/v2/cards")).toBe(false);
  });
  it("configuration failure performs zero provider requests and releases safe retry",async()=>{
    const f=await fixture();const network=transport("success");control.configFailure=true;
    await saveCardWithManagementCapability(f);expect(network.calls).toHaveLength(0);
    expect((await bookingState(f.booking)).card_protection_status).toBe("retry_required");
    expect((await operation(f.booking)).first_failure_code).toBe("square_config_unavailable");
  });
  it.each(["response_loss","db_before","db_after"] as const)("recovers %s without CreateCard again, including DB-committed response loss",async(mode)=>{
    const f=await fixture();const network=transport(mode);await saveCardWithManagementCapability(f);
    const op=await operation(f.booking);
    if(op.status!=="succeeded") { due(op.id); const r=await reconcileBookingCardSaveOperations(1,op.id);expect(r.reconciled).toBe(1); }
    expect((await bookingState(f.booking)).card_protection_status).toBe("saved");
    await saveCardWithManagementCapability(f);
    expect(network.calls.filter(c=>c.path==="/v2/cards"&&c.method==="POST")).toHaveLength(1);
    expect((await rpc("inspect_booking_card_recovery",{p_token_id:f.tokenId})).protection_status).toBe("saved");
  });
  it("one read lease wins a race; multiple matching cards remain manual review",async()=>{
    const f=await fixture();const network=transport("response_loss");await saveCardWithManagementCapability(f);
    const op=await operation(f.booking);due(op.id);
    const card=network.getCards()[0] as Record<string,unknown>;network.setCards([card,{...card,id:"card_second"}]);
    await Promise.all(Array.from({length:12},()=>reconcileBookingCardSaveOperations(1,op.id)));
    expect(network.calls.filter(c=>c.method==="GET")).toHaveLength(1);
    expect((await bookingState(f.booking)).card_protection_status).toBe("manual_review");
    expect((await operation(f.booking)).first_failure_code).toBe("provider_response_lost");
  });
  it("three completed empty reads after the observation window permit a new token",async()=>{
    const f=await fixture();const network=transport("response_loss");await saveCardWithManagementCapability(f);
    const op=await operation(f.booking);network.setCards([]);
    for(let i=0;i<3;i++) {
      due(op.id);
      // The cron path respects the due schedule without the interactive cooldown.
      await reconcileBookingCardSaveOperations(10);
      if(i<2) expect((await bookingState(f.booking)).card_protection_status).not.toBe("retry_required");
    }
    expect((await bookingState(f.booking)).card_protection_status).toBe("retry_required");
    const link=await rpc("recover_booking_card_management",{p_token_id:f.tokenId});
    const replay=await rpc("recover_booking_card_management",{p_token_id:f.tokenId});
    expect(link.ok).toBe(true);expect(link.token_id).toBe(replay.token_id);
    expect(network.calls.filter(c=>c.path==="/v2/cards"&&c.method==="POST")).toHaveLength(1);
  });
  it("a bound disabled receipt closes the old operation before permitting new card entry",async()=>{
    const f=await fixture();const network=transport("response_loss");await saveCardWithManagementCapability(f);
    const op=await operation(f.booking);due(op.id);
    network.setCards([{...(network.getCards()[0] as Record<string,unknown>),enabled:false}]);
    await reconcileBookingCardSaveOperations(1,op.id);
    expect((await bookingState(f.booking)).card_protection_status).toBe("retry_required");
    expect((await operation(f.booking)).status).toBe("failed");
    expect((await operation(f.booking)).reconciliation_receipt.enabled).toBe(false);
    const link=await rpc("recover_booking_card_management",{p_token_id:f.tokenId});expect(link.ok).toBe(true);
    expect(network.calls.filter(c=>c.path==="/v2/cards"&&c.method==="POST")).toHaveLength(1);
    const {data:events}=await db.from("booking_card_delivery_events").select("reconciliation_outcome").eq("operation_id",op.id);
    expect(events).toContainEqual({reconciliation_outcome:"disabled_card"});
  });
});
