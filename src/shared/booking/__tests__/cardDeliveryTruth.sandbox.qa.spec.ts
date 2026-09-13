import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createCardSandboxGuard, readCardSandboxConfig, type CardSandboxMode } from "../../../../scripts/qa-square-card-sandbox-guard";

// Explicit opt-in only. This exercises actual Square Sandbox card endpoints,
// with fixed test nonces. It is backend certification, not Web Payments SDK QA.
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: async () => {
  const { SquareProvider } = await import("@/shared/integrations/payments/square");
  if (!config) throw new Error("sandbox_not_enabled");
  return new SquareProvider(config.square);
} }));
vi.mock("@/shared/integrations/square/client", async original => ({
  ...await original<typeof import("@/shared/integrations/square/client")>(), getSquareConfig: async () => config?.square ?? null,
}));
import { saveCardWithManagementCapability } from "../bookingCardManagement";
import { reconcileBookingCardSaveOperations } from "../reconcileBookingCardSaveOperations";

const enabled = process.env.NAILIQ_CARD_SANDBOX_QA === "1";
const recoveryOperationId = process.env.NAILIQ_CARD_SANDBOX_RECOVER_OPERATION_ID;
if (enabled && recoveryOperationId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recoveryOperationId)) {
  throw new Error("sandbox_recovery_operation_invalid");
}
const config = enabled ? readCardSandboxConfig(process.env) : null;
const db = createClient(config?.supabaseUrl ?? "http://127.0.0.1:55631", config?.serviceRoleKey ?? "unused-local-key", { auth: { persistSession:false, autoRefreshToken:false } });
const nativeFetch = globalThis.fetch;
const guard = config ? createCardSandboxGuard(config, nativeFetch) : null;
const salon = "55630000-0000-4000-8000-000000000060";
const service = "55630000-0000-4000-8000-000000000061";
const staff = "55630000-0000-4000-8000-000000000062";
let journal: number | null = null;
let sequence = 0;
type SandboxSource = "cnon:card-nonce-ok" | "cnon:card-nonce-declined";
type FixtureContact = { email?: string; phone?: string; verifiedSms?: boolean };
function note(value: Record<string, unknown>) {
  if (journal === null) throw new Error("sandbox_journal_required");
  appendFileSync(journal, JSON.stringify({ at:new Date().toISOString(), ...value }) + "\n");
}
function sql(query: string) {
  if (!config || !guard) throw new Error("sandbox_not_enabled");
  try { return execFileSync("/opt/homebrew/bin/psql", [config.databaseUrl,"-X","-qAt","-v","ON_ERROR_STOP=1","-c",query], {encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim(); }
  catch { throw new Error("disposable_qa_sql_failed"); }
}
async function rpc(name: string, args: Record<string, unknown>) {
  const {data,error} = await db.rpc(name,args);
  if (error) throw new Error("disposable_qa_rpc_failed");
  return data;
}
async function fixture(sourceToken: SandboxSource = "cnon:card-nonce-ok", contact: FixtureContact = {}) {
  const booking = randomUUID();
  const email = contact.email ?? `synthetic-${booking}@example.com`;
  const phone = contact.phone ?? "";
  if (!/^synthetic-[a-z0-9-]+@example\.com$/.test(email)) throw new Error("synthetic_contact_required");
  if (phone !== "" && !/^\+1604555\d{4}$/.test(phone)) throw new Error("synthetic_phone_required");
  if (contact.verifiedSms && !phone) throw new Error("synthetic_sms_phone_required");
  // Declared contact is test input, never identity authority. A fresh booking
  // remains booking-scoped unless the exact consumed SMS proof is seeded below.
  sql(`INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,client_email,start_time_utc,end_time_utc,status,price_cents,noshow_card_required,noshow_fee_cents)
    VALUES('${booking}','${salon}','${service}','${staff}','Synthetic Sandbox','${phone}','${email}',
    date_trunc('hour',now())+interval '3 days ${++sequence} hours',date_trunc('hour',now())+interval '3 days ${sequence} hours 30 minutes','confirmed',5000,true,1000);`);
  if (contact.verifiedSms) {
    const session = randomUUID();
    // Synthetic DB proof only. This fixture does not request or send an OTP.
    sql(`BEGIN;
      INSERT INTO public.phone_otp_sessions(id,phone,salon_id,verified_channel,verified_at,expires_at,consumed_at,consumed_by_booking_id)
      VALUES('${session}','${phone}','${salon}','sms',now()-interval '4 minutes',now()+interval '10 minutes',now()-interval '3 minutes','${booking}');
      UPDATE public.bookings SET otp_session_id='${session}' WHERE id='${booking}' AND salon_id='${salon}';
      COMMIT;`);
  }
  const cap = await rpc("mint_booking_management_capability",{p_salon_id:salon,p_booking_id:booking,p_action:"card_manage",p_min_expires_at:new Date(Date.now()+25*60_000).toISOString()});
  if (cap.ok !== true) throw new Error("disposable_qa_capability_failed");
  note({event:"fixture_reserved",bookingId:booking});
  return {booking,tokenId:cap.token_id as string,requestId:randomUUID(),provider:"square" as const,sourceToken};
}
async function state(booking: string) {
  const {data,error}=await db.from("bookings").select("status,card_protection_status,noshow_card_id,noshow_customer_id,noshow_card_brand,noshow_card_last4,noshow_consent_at,noshow_consent_meta").eq("id",booking).single();
  if(error || !data) throw new Error("disposable_booking_read_failed");
  return data;
}
async function operation(booking: string) {
  const {data,error}=await db.from("booking_card_save_operations").select("id,status,customer_claim_id,first_failure_code,first_failure_stage").eq("booking_id",booking).order("created_at",{ascending:false}).order("delivery_sequence",{ascending:false}).limit(1).single();
  if(error || !data) throw new Error("disposable_operation_read_failed");
  note({event:"operation_inspected",bookingId:booking,operationId:data.id,status:data.status,failureCode:data.first_failure_code});
  return data;
}
async function retryClosedAttempt(f: Awaited<ReturnType<typeof fixture>>, sourceToken: SandboxSource = "cnon:card-nonce-ok") {
  // Never enter a new source while the prior provider outcome is unknown.
  expect((await operation(f.booking)).status).toBe("failed");
  const retry = await rpc("recover_booking_card_management",{p_token_id:f.tokenId});
  expect(retry.ok).toBe(true);
  return {...f,tokenId:retry.token_id as string,requestId:randomUUID(),sourceToken};
}
async function assertCustomerAuthority(booking: string, authority: "booking" | "verified_phone") {
  const claimId = (await operation(booking)).customer_claim_id;
  expect(claimId).toBeTruthy();
  const {data,error} = await db.from("square_card_customer_claims")
    .select("identity_version,authority_kind,identity_authorized")
    .eq("id",claimId).eq("salon_id",salon).single();
  if (error || !data) throw new Error("disposable_customer_authority_read_failed");
  expect(data).toEqual({identity_version:2,authority_kind:authority,identity_authorized:true});
}
async function reconcile(booking: string) {
  const op=await operation(booking);
  if(op.status!=="succeeded") {
    // Respect the actual dispatch/lease/backoff windows. Advancing only the
    // schedule caused the first real response-loss test to claim at <1s and
    // correctly receive reconciliation_wait before any provider card read.
    const deadline=Date.now()+150_000;
    note({event:"reconciliation_safety_wait_started",operationId:op.id});
    for (;;) {
      const readiness=JSON.parse(sql(`SELECT jsonb_build_object('status',op.status,'ready',
        op.status IN ('sending','unknown') AND op.dispatch_prepared_at IS NOT NULL
        AND op.dispatch_prepared_at<=transaction_timestamp()-interval '2 minutes'
        AND (op.next_reconcile_at IS NULL OR op.next_reconcile_at<=transaction_timestamp())
        AND (op.reconciliation_lease_expires_at IS NULL OR op.reconciliation_lease_expires_at<=transaction_timestamp())
        AND NOT EXISTS(SELECT 1 FROM public.booking_card_delivery_events ev WHERE ev.operation_id=op.id
          AND ev.stage='reconciliation' AND ev.created_at>transaction_timestamp()-interval '2 minutes'))
        FROM public.booking_card_save_operations op WHERE op.id='${op.id}' AND op.salon_id='${salon}';`)) as {status:string;ready:boolean};
      if(readiness.status==="succeeded") return;
      if(!["sending","unknown"].includes(readiness.status)) throw new Error("sandbox_reconciliation_operation_closed");
      if(readiness.ready) break;
      if(Date.now()>=deadline) throw new Error("sandbox_reconciliation_safety_wait_exceeded");
      await new Promise(resolve=>setTimeout(resolve,Math.min(5_000,deadline-Date.now())));
    }
    const result=await reconcileBookingCardSaveOperations(1,op.id);
    note({event:"reconciliation_completed",operationId:op.id,...result,counts:guard?.counts()});
    expect(result.reconciled).toBe(1);
  }
}
async function assertSaved(booking: string) {
  const saved=await state(booking);
  expect(saved.status).toBe("confirmed");expect(saved.card_protection_status).toBe("saved");
  expect(saved.noshow_card_id).toMatch(/^[A-Za-z0-9:_-]+$/);expect(saved.noshow_customer_id).toMatch(/^[A-Za-z0-9:_-]+$/);
  expect(saved.noshow_card_brand).toBeTruthy();expect(saved.noshow_card_last4).toMatch(/^\d{4}$/);
  expect(saved.noshow_consent_at).toBeTruthy();expect(saved.noshow_consent_meta.policyVersion).toMatch(/^nsp_[a-f0-9]{64}$/);
  expect((await operation(booking)).status).toBe("succeeded");
}

describe.skipIf(!enabled)("Actual Square Sandbox cards + disposable PostgreSQL (explicit opt-in)",()=>{
  beforeAll(async()=>{
    if(!config || !guard) throw new Error("sandbox_not_enabled");
    const path=process.env.NAILIQ_CARD_SANDBOX_JOURNAL ?? "";
    if(!isAbsolute(path) || !path.endsWith(".jsonl")) throw new Error("sandbox_absolute_journal_path_required");
    // Refuse reusing a run journal, including after interruption. Inspect the
    // recorded operation and reconcile it before deliberately starting a new run.
    journal=openSync(path,"wx",0o600);
    writeFileSync(journal,"",{encoding:"utf8"});note({event:"run_started",provider:"square",environment:"sandbox",notificationMode:config.notificationMode});
    // Refuse certifying the R10 client against the old contact-sharing schema.
    // This read occurs before any Square preflight or fixture mutation.
    expect(sql(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
      AND table_name='square_card_customer_claims' AND column_name IN ('identity_version','authority_kind','identity_authorized');`)).toBe("3");
    expect(sql(`SELECT to_regprocedure('public.square_card_booking_phone_authorized(uuid,uuid,jsonb)') IS NOT NULL;`)).toBe("t");
    note({event:"customer_authority_v2_schema_present"});
    await guard.preflight();note({event:"identity_and_webhooks_off_verified"});
    vi.stubGlobal("fetch",recoveryOperationId ? async(input:RequestInfo|URL,init?:RequestInit)=>{
      const request=new Request(input,init);const url=new URL(request.url);
      if(url.origin==="https://connect.squareupsandbox.com" && (request.method!=="GET" ||
        url.pathname!=="/v2/cards" || url.searchParams.get("reference_id")!==`nq-card:${recoveryOperationId}`)) {
        throw new Error("sandbox_recovery_provider_mutation_denied");
      }
      return guard.fetch(request);
    } : guard.fetch);
    if(recoveryOperationId) return;
    sequence=Number(sql(`SELECT count(*) FROM public.bookings WHERE salon_id='${salon}'`));
    sql(`INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('card-sandbox-certification','QA','QA') ON CONFLICT DO NOTHING;
      INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,profile_complete,noshow_protection_enabled,cancellation_policy)
      VALUES('${salon}','card-sandbox-certification','Synthetic Sandbox Certification','+16045550160','America/Vancouver','CAD',true,true,'{"en":"Cancel with 24 hours notice.","vi":"Báo trước 24 giờ khi hủy."}') ON CONFLICT DO NOTHING;
      INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category) VALUES('${service}','${salon}','QA Service',5000,30,'card-sandbox-certification') ON CONFLICT DO NOTHING;
      INSERT INTO public.staff(id,salon_id,name,status) VALUES('${staff}','${salon}','QA Staff','active') ON CONFLICT DO NOTHING;`);
  },60_000);
  afterAll(()=>{
    vi.unstubAllGlobals();
    if(journal!==null) {note({event:"run_finished",counts:guard?.counts()});closeSync(journal);journal=null;}
  });
  it.skipIf(!!recoveryOperationId)("saves a complete receipt, races 12 identical requests and replays without another card",async()=>{
    guard!.setMode("success");const f=await fixture();
    const result=await Promise.all(Array.from({length:12},()=>saveCardWithManagementCapability(f)));
    expect(result.some(r=>r.ok)).toBe(true);await assertSaved(f.booking);
    await saveCardWithManagementCapability(f);
    expect(guard!.counts()).toMatchObject({customerCreates:1,cardCreates:1});note({event:"same_operation_race_pass",counts:guard!.counts()});
  },60_000);
  it.skipIf(!!recoveryOperationId)("records a real Sandbox decline, blocks replay and safely saves a fresh card",async()=>{
    guard!.setMode("success");const f=await fixture("cnon:card-nonce-declined");
    expect((await saveCardWithManagementCapability(f)).ok).toBe(false);
    expect((await state(f.booking)).card_protection_status).toBe("retry_required");
    expect((await operation(f.booking)).first_failure_stage).toBe("card_create");
    const declined = await operation(f.booking);
    await saveCardWithManagementCapability(f);expect(guard!.counts().cardCreates).toBe(1);
    const retried = await retryClosedAttempt(f);
    expect((await saveCardWithManagementCapability(retried)).ok).toBe(true);
    await assertSaved(f.booking);
    expect((await operation(f.booking)).customer_claim_id).toBe(declined.customer_claim_id);
    await saveCardWithManagementCapability(retried);
    expect(guard!.counts()).toMatchObject({customerCreates:1,cardCreates:2});
    note({event:"sandbox_decline_and_fresh_card_recovery_pass",counts:guard!.counts()});
  },60_000);
  it.skipIf(!!recoveryOperationId).each(["before_dispatch","response_loss","db_before","db_after"] as const)("handles %s at the real-provider transport boundary",async(mode:CardSandboxMode)=>{
    guard!.setMode(mode);const f=await fixture();await saveCardWithManagementCapability(f);
    if(mode==="before_dispatch") {
      expect((await state(f.booking)).card_protection_status).toBe("retry_required");
      expect(guard!.counts()).toMatchObject({customerCreates:0,cardCreates:0});
      note({event:"before_dispatch_no_mutation_confirmed",counts:guard!.counts()});
      guard!.setMode("success");
      expect((await saveCardWithManagementCapability(await retryClosedAttempt(f))).ok).toBe(true);
      await assertSaved(f.booking);
      expect(guard!.counts()).toMatchObject({customerCreates:1,cardCreates:1});
    } else {
      // Repeating the old request before reconciliation must not replay a
      // dispatched card source. db_after may already be durably succeeded.
      await saveCardWithManagementCapability(f);
      expect(guard!.counts().cardCreates).toBe(1);
      await reconcile(f.booking);await assertSaved(f.booking);await saveCardWithManagementCapability(f);
      expect(guard!.counts().cardCreates).toBe(1);
    }
    note({event:`${mode}_pass`,counts:guard!.counts()});
  },180_000);
  it.skipIf(!!recoveryOperationId)("keeps two unverified same-contact bookings in separate customer identities",async()=>{
    guard!.setMode("success");
    const contact = {email:`synthetic-${randomUUID()}@example.com`,phone:`+1604555${String(randomInt(10_000)).padStart(4,"0")}`};
    const a=await fixture("cnon:card-nonce-ok",contact);const b=await fixture("cnon:card-nonce-ok",contact);
    const results = await Promise.all([saveCardWithManagementCapability(a),saveCardWithManagementCapability(b)]);
    expect(results.every(result=>result.ok)).toBe(true);
    for (const f of [a,b]) {
      await assertSaved(f.booking);
      await assertCustomerAuthority(f.booking,"booking");
    }
    const bookings = await Promise.all([state(a.booking),state(b.booking)]);
    expect(bookings[0].noshow_customer_id).not.toBe(bookings[1].noshow_customer_id);
    expect((await operation(a.booking)).customer_claim_id).not.toBe((await operation(b.booking)).customer_claim_id);
    expect(guard!.counts()).toMatchObject({customerCreates:2,cardCreates:2});
    note({event:"unverified_contact_booking_isolation_pass",counts:guard!.counts()});
  },60_000);
  it.skipIf(!!recoveryOperationId)("shares one customer only for exact consumed SMS authority on both bookings",async()=>{
    guard!.setMode("success");
    const contact = {email:`synthetic-${randomUUID()}@example.com`,phone:`+1604555${String(randomInt(10_000)).padStart(4,"0")}`,verifiedSms:true};
    const a=await fixture("cnon:card-nonce-ok",contact);const b=await fixture("cnon:card-nonce-ok",contact);
    await Promise.all([saveCardWithManagementCapability(a),saveCardWithManagementCapability(b)]);
    for(const f of [a,b]) {
      if((await state(f.booking)).card_protection_status!=="saved") {
        // A follower is permitted to wait before any provider mutation. A new
        // logical card attempt is allowed only after its prior attempt closed.
        expect((await saveCardWithManagementCapability(await retryClosedAttempt(f))).ok).toBe(true);
      }
      await assertSaved(f.booking);
      await assertCustomerAuthority(f.booking,"verified_phone");
    }
    const bookings=await Promise.all([state(a.booking),state(b.booking)]);
    expect(bookings[0].noshow_customer_id).toBe(bookings[1].noshow_customer_id);
    expect((await operation(a.booking)).customer_claim_id).toBe((await operation(b.booking)).customer_claim_id);
    // The finite synthetic phone pool may already exist in the Sandbox from
    // an earlier run. Validated reuse requires zero creates; a new phone needs
    // one. Neither path is permitted to create two customers for this authority.
    expect(guard!.counts().customerCreates).toBeLessThanOrEqual(1);
    expect(guard!.counts().cardCreates).toBe(2);
    note({event:"consumed_sms_customer_race_pass",counts:guard!.counts()});
  },60_000);
  it.skipIf(!recoveryOperationId)("recovers only the explicitly selected existing operation using provider reads",async()=>{
    const {data:existing,error}=await db.from("booking_card_save_operations")
      .select("id,booking_id,status,provider,expected_environment,expected_merchant_id")
      .eq("id",recoveryOperationId!).eq("salon_id",salon).single();
    if(error || !existing || existing.provider!=="square" || existing.expected_environment!=="sandbox" ||
      existing.expected_merchant_id!==config!.square.merchantId || !["sending","unknown","succeeded"].includes(existing.status)) {
      throw new Error("sandbox_recovery_binding_invalid");
    }
    if((await operation(existing.booking_id)).id!==recoveryOperationId) throw new Error("sandbox_recovery_operation_superseded");
    note({event:"existing_operation_recovery_started",operationId:existing.id,bookingId:existing.booking_id,originalStatus:existing.status});
    await reconcile(existing.booking_id);await assertSaved(existing.booking_id);
    const reads=guard!.counts().cardReads;
    await reconcile(existing.booking_id);await assertSaved(existing.booking_id);
    expect(guard!.counts()).toMatchObject({customerCreates:0,cardCreates:0,cardReads:reads});
    note({event:"existing_operation_recovery_pass",operationId:existing.id,counts:guard!.counts()});
  },180_000);
});
