import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

// Only the Next request container is supplied by the harness. Auth validation,
// session revocation, memberships, action code, RLS and RPCs all run unchanged.
const request = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => {
    const jar = request.cookies;
    return {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      get: (name: string) => jar.has(name) ? { value: jar.get(name) } : undefined,
      set: (name: string, value: string) => { jar.set(name, value); },
    };
  },
  headers: async () => new Headers({ "x-forwarded-proto": "https" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { createClient } from "@/shared/lib/supabase/server";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { actOnCardProtectionException, loadCardProtectionExceptions } from "../cardProtectionExceptionActions";

const enabled = process.env.NAILIQ_CARD_EXCEPTIONS_AUTH_QA === "1";
const qa = "https://osdqutwunokiielbairj.supabase.co";
const evidence = process.env.NAILIQ_QA_ARTIFACT_DIR ?? "";
const roles = ["owner", "admin", "senior", "receptionist", "nail_tech", "outsider"] as const;
type Role = typeof roles[number];
type Fixture = { id: string; slug: string; bookingId: string; raceBookingId: string; pastBookingId: string };
type Actor = { id: string; role: Role; email: string; password: string; client?: SupabaseClient; jar?: Map<string,string> };
const fixtures: Fixture[] = [], actors: Actor[] = [];
let db: SupabaseClient;
let deniedEgress = 0;
const nativeFetch = globalThis.fetch;
function note(value: Record<string, unknown>) {
  appendFileSync(`${evidence}/events.jsonl`, JSON.stringify(value) + "\n");
}
function ok(error: { code?: string } | null) {
  if (error) throw new Error(`qa_database_error:${error.code ?? "unknown"}`);
}
function bookingIds(f: Fixture) {
  return [f.bookingId, f.raceBookingId, f.pastBookingId];
}
async function use(role: Role) {
  const actor = actors.find(a => a.role === role)!;
  request.cookies = actor.jar!;
  return actor;
}
async function snapshot(f: Fixture) {
  const r = await db.from("bookings").select("id,status,card_protection_status,card_protection_reviewed_at,card_protection_reviewed_by,noshow_card_id,noshow_customer_id")
    .eq("salon_id", f.id).order("id"); ok(r.error); return r.data;
}

describe.skipIf(!enabled)("Card exceptions with real QA Auth and canonical server actions", () => {
  beforeAll(async () => {
    if (!isAbsolute(evidence) || process.env.NEXT_PUBLIC_SUPABASE_URL !== qa || process.env.SUPABASE_INTERNAL_URL !== qa
      || process.env.DEMO_OTP !== "false" || process.env.NEXT_PUBLIC_DEMO_OTP !== "false"
      || process.env.NAILIQ_CARD_SAVE_DISPATCH_DISABLED !== "true"
      || ["DISABLE_OUTBOUND_SMS", "DISABLE_OUTBOUND_EMAIL", "DISABLE_OUTBOUND_CALLS"].some(k => process.env[k] !== "1")
      || ["PAYMENT_LEDGER_WORKERS_ENABLED", "NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH", "NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH"].some(k => process.env[k] !== "false")) {
      throw new Error("isolated_qa_and_all_dispatch_off_required");
    }
    const claims = JSON.parse(Buffer.from(process.env.SUPABASE_SERVICE_ROLE_KEY!.split(".")[1], "base64url").toString());
    if (claims.ref !== "osdqutwunokiielbairj" || claims.role !== "service_role") throw new Error("qa_service_key_required");
    mkdirSync(evidence, { recursive: true });
    writeFileSync(`${evidence}/events.jsonl`, "", { flag: "wx", mode: 0o600 });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== qa || !(url.pathname.startsWith("/rest/v1/") || url.pathname.startsWith("/auth/v1/"))) {
        deniedEgress++; throw new Error("non_qa_transport_blocked");
      }
      return nativeFetch(input, { ...init, redirect: "error" });
    });
    db = createSupabaseClient(qa, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession:false,autoRefreshToken:false } });
    for (const label of ["A", "B"]) {
      const f = { id:randomUUID(), slug:`e2e-b01-exception-${label.toLowerCase()}-${randomUUID()}`,
        bookingId:randomUUID(), raceBookingId:randomUUID(), pastBookingId:randomUUID() };
      fixtures.push(f); note({ event:"fixture_planned", ...f });
      ok((await db.from("salons").insert({ id:f.id,slug:f.slug,name:`E2E Exceptions ${label}`,phone:"12505550195",timezone:"America/Vancouver",
        tax_lines:[],profile_complete:true,booking_verification_mode:"never",phone_otp_enabled:false,sms_outbound_enabled:false,email_outbound_enabled:false,
        email_links_enabled:false,voice_ai_enabled:false,reminders_enabled:false,reminder_24h_enabled:false,reminder_3h_enabled:false,sms_reminders_enabled:false,
        noshow_protection_enabled:true,currency_code:"CAD",cancellation_policy:{en:"Synthetic QA policy"} })).error);
      const serviceId=randomUUID(), staffId=randomUUID();
      ok((await db.from("services").insert({id:serviceId,salon_id:f.id,name:`QA Service ${label}`,price_cents:5000,duration_minutes:30})).error);
      ok((await db.from("staff").insert({id:staffId,salon_id:f.id,name:`QA Staff ${label}`,job_role:"nail_tech"})).error);
      for (const [index,id] of [f.bookingId,f.raceBookingId].entries()) {
        const start=Date.now()+14*86400000+index*7200000;
        ok((await db.from("bookings").insert({id,salon_id:f.id,service_id:serviceId,staff_id:staffId,
          client_name:`Synthetic ${label} Private`,client_phone:"12505550195",client_email:`synthetic-${randomUUID()}@example.com`,
          status:"confirmed",source:"appointment",price_cents:5000,noshow_card_required:true,noshow_fee_cents:1000,
          start_time_utc:new Date(start).toISOString(),end_time_utc:new Date(start+1800000).toISOString()})).error);
      }
      const pastStart=Date.now()-14*86400000;
      ok((await db.from("bookings").insert({id:f.pastBookingId,salon_id:f.id,service_id:serviceId,staff_id:staffId,
        client_name:`Synthetic ${label} Past`,client_phone:"12505550195",client_email:`synthetic-${randomUUID()}@example.com`,
        status:"completed",source:"appointment",price_cents:5000,noshow_card_required:true,noshow_fee_cents:1000,
        start_time_utc:new Date(pastStart).toISOString(),end_time_utc:new Date(pastStart+1800000).toISOString()})).error);
    }
    for (const role of roles) {
      const email=`qa-b01-${randomUUID()}@example.com`, password=`${randomUUID()}Aa1!`;
      const r=await db.auth.admin.createUser({email,password,email_confirm:true});ok(r.error);
      if(!r.data.user) throw new Error("qa_user_missing");
      const actor: Actor={id:r.data.user.id,role,email,password};actors.push(actor);note({event:"actor_created",id:actor.id,role});
      ok((await db.from("salon_members").insert({salon_id:fixtures[role==="outsider"?1:0].id,user_id:actor.id,role:role==="outsider"?"owner":role})).error);
      request.cookies=new Map();
      const client=await createClient();const signed=await client.auth.signInWithPassword({email,password});ok(signed.error);
      expect(signed.data.user?.id).toBe(actor.id);
      actor.client=client;actor.jar=request.cookies;
      expect(actor.jar.size).toBeGreaterThan(0);
    }
    note({event:"ready",actors:actors.length,salons:fixtures.length,realAuth:true,providerCalls:0});
  }, 120000);

  afterAll(async () => {
    if (!db) { vi.unstubAllGlobals(); return; }
    const failures: string[]=[];
    for(const actor of actors) {
      try {
        request.cookies=actor.jar??new Map();
        if(actor.client) ok((await actor.client.auth.signOut({scope:"global"})).error);
        ok((await db.from("salon_members").delete().eq("user_id",actor.id).in("salon_id",fixtures.map(f=>f.id))).error);
        // Keep synthetic actors referenced by immutable/review audit, but remove all access.
        ok((await db.auth.admin.updateUserById(actor.id,{ban_duration:"876000h"})).error);
      } catch { failures.push(`actor:${actor.id}`); }
    }
    for(const f of fixtures) {
      try {
        const caps=await db.from("booking_management_capabilities").select("id,created_at").eq("salon_id",f.id);ok(caps.error);
        for(const cap of caps.data??[]) ok((await db.from("booking_management_capabilities").update({expires_at:new Date(Math.max(Date.parse(cap.created_at)+1,Date.now()-1000)).toISOString()}).eq("id",cap.id).eq("salon_id",f.id)).error);
        ok((await db.from("bookings").update({deleted_at:new Date().toISOString()}).eq("salon_id",f.id).in("id",bookingIds(f))).error);
        ok((await db.from("salons").update({archived_at:new Date().toISOString(),profile_complete:false}).eq("id",f.id).eq("slug",f.slug)).error);
      } catch { failures.push(`fixture:${f.id}`); }
    }
    note({event:"cleanup",failures,deniedEgress});
    vi.unstubAllGlobals();expect(failures).toEqual([]);expect(deniedEgress).toBe(0);
  },120000);

  it.each(roles)("%s: list uses current authenticated membership and minimal disclosure", async role => {
    const actor=await use(role);
    const own=await getDashboardWriteClient(fixtures[role==="outsider"?1:0].slug);
    expect(own?.userId).toBe(actor.id);expect(own?.role).toBe(role==="outsider"?"owner":role);
    const r=await loadCardProtectionExceptions(fixtures[0].slug);
    if(role==="owner"||role==="admin") {
      expect(r.ok).toBe(true);expect(r.items).toHaveLength(2);
      expect(r.items.every(x=>x.clientLabel==="S. A."&&x.status==="awaiting_card"&&!x.canReconcile)).toBe(true);
      expect(r.items.map(x=>x.bookingId).sort()).toEqual([fixtures[0].bookingId,fixtures[0].raceBookingId].sort());
      expect(r.items.some(x=>x.bookingId===fixtures[0].pastBookingId)).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/Private|@example|1250555|noshow_card_id|noshow_customer_id|source_token|access_token/);
    } else {
      expect(r).toEqual({ok:false,items:[]});
      for(const action of ["retry_link","reviewed","reconcile"] as const) expect(await actOnCardProtectionException(fixtures[0].slug,fixtures[0].bookingId,action)).toEqual({ok:false});
    }
    note({event:"role_list_and_denials",role,passed:true});
  },30000);

  it("owner cannot read another salon or act on a foreign booking ID",async()=>{
    await use("owner");const before=await snapshot(fixtures[1]);
    expect(await loadCardProtectionExceptions(fixtures[1].slug)).toEqual({ok:false,items:[]});
    for(const action of ["retry_link","reviewed","reconcile"] as const) expect(await actOnCardProtectionException(fixtures[0].slug,fixtures[1].bookingId,action)).toEqual({ok:false});
    expect(await snapshot(fixtures[1])).toEqual(before);
    expect((await db.from("booking_management_capabilities").select("id").eq("salon_id",fixtures[1].id)).data).toEqual([]);
  },30000);

  it.each(["owner","admin"] as const)("%s: retry link replay and reviewed flag preserve unprotected state",async role=>{
    const actor=await use(role),f=fixtures[0];
    const one=await actOnCardProtectionException(f.slug,f.bookingId,"retry_link");
    expect(one.ok).toBe(true);expect(one.retryPath).toMatch(/^\/booking\/save-card\?token=[0-9a-f-]{36}$/);
    expect(await actOnCardProtectionException(f.slug,f.bookingId,"retry_link")).toEqual(one);
    expect(await actOnCardProtectionException(f.slug,f.bookingId,"reviewed")).toEqual({ok:true});
    const rows=await snapshot(f),row=rows!.find(b=>b.id===f.bookingId)!;
    expect(row.card_protection_reviewed_by).toBe(actor.id);expect(row.card_protection_status).toBe("awaiting_card");
    expect(row.status).toBe("confirmed");expect(row.noshow_card_id).toBeNull();
  },30000);

  it("three simultaneous first retry-link actions return one durable capability",async()=>{
    await use("owner");const f=fixtures[0];
    const r=await Promise.all([1,2,3].map(()=>actOnCardProtectionException(f.slug,f.raceBookingId,"retry_link")));
    expect(r.every(x=>x.ok)).toBe(true);expect(new Set(r.map(x=>x.retryPath)).size).toBe(1);
    const caps=await db.from("booking_management_capabilities").select("id").eq("salon_id",f.id).eq("booking_id",f.raceBookingId);ok(caps.error);expect(caps.data).toHaveLength(1);
  },30000);

  it("same authenticated session loses authority immediately after demotion or removal",async()=>{
    const actor=await use("admin"),f=fixtures[0];
    expect((await getDashboardWriteClient(f.slug))?.role).toBe("admin");
    ok((await db.from("salon_members").update({role:"nail_tech"}).eq("salon_id",f.id).eq("user_id",actor.id)).error);
    expect((await getDashboardWriteClient(f.slug))?.role).toBe("nail_tech");
    const before=await snapshot(f);
    expect(await loadCardProtectionExceptions(f.slug)).toEqual({ok:false,items:[]});
    for(const action of ["retry_link","reviewed","reconcile"] as const) expect(await actOnCardProtectionException(f.slug,f.bookingId,action)).toEqual({ok:false});
    ok((await db.from("salon_members").delete().eq("salon_id",f.id).eq("user_id",actor.id)).error);
    expect(await getDashboardWriteClient(f.slug)).toBeNull();expect(await snapshot(f)).toEqual(before);
  },30000);

  it("revoked session and anonymous request cannot read exceptions",async()=>{
    const actor=await use("owner"),f=fixtures[0],stale=new Map(request.cookies);
    expect(stale.size).toBeGreaterThan(0);
    const current=await createClient();
    const session=await current.auth.getSession();ok(session.error);
    expect(session.data.session?.user.id).toBe(actor.id);
    const token=session.data.session!.access_token;
    expect((await current.rpc("current_auth_session_is_active")).data).toBe(true);
    ok((await current.auth.signOut({scope:"global"})).error);
    const revoked=await fetch(`${qa}/rest/v1/rpc/current_auth_session_is_active`,{method:"POST",headers:{
      apikey:process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:"{}"});
    expect(revoked.status).toBe(200);expect(await revoked.json()).toBe(false);
    request.cookies=stale;
    expect(await loadCardProtectionExceptions(f.slug)).toEqual({ok:false,items:[]});
    expect(await actOnCardProtectionException(f.slug,f.bookingId,"reviewed")).toEqual({ok:false});
    request.cookies=new Map();expect(await loadCardProtectionExceptions(f.slug)).toEqual({ok:false,items:[]});
  },30000);

  it("authenticated database clients cannot call privileged exception RPCs or read operation material",async()=>{
    const actor=await use("outsider");const f=fixtures[1];
    for(const name of ["mint_owner_booking_card_retry","mark_booking_card_protection_reviewed"]) {
      const r=await actor.client!.rpc(name,{p_salon_id:f.id,p_booking_id:f.bookingId,p_actor_id:actor.id});expect(r.error?.code).toBe("42501");
    }
    const r=await actor.client!.from("booking_card_save_operations").select("*").eq("salon_id",fixtures[0].id);
    expect(r.error?.code).toBe("42501");
    const ops=await db.from("booking_card_save_operations").select("id").in("salon_id",fixtures.map(f=>f.id));ok(ops.error);expect(ops.data).toEqual([]);
  },30000);
});
