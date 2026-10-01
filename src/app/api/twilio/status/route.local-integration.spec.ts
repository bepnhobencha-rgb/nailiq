import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
// Mock only credential lookup, never signature validation, route or persistence.
vi.mock("@/shared/lib/twilioSignature", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/twilioSignature")>();
  return { ...actual, getTwilioAuthToken: async () => "synthetic-local-callback-token" };
});

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { claimSmsDeliveryAttempt, completeSmsDeliveryAttempt } from "@/shared/lib/smsDeliveryTruth";
import { completeReviewRequestSmsNotification } from "@/shared/lib/notificationLog";
import { POST } from "./route";

const enabled = process.env.NAILIQ_LOCAL_SMS_CALLBACK_INTEGRATION === "1";
const salon = "30260930-0000-4000-8000-000000000001";
const callbackBase = "http://127.0.0.1:3117/api/twilio/status";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

describe.skipIf(!enabled)("local signed SMS callback and PostgreSQL receipt boundary", () => {
  let db: ReturnType<typeof createServiceRoleClient>;
  let ownsSalon = false;
  let outsideAttempts = 0;
  let sequence = 0;
  const ownedSids = new Set<string>();

  // Read-only inspection of private rows; no grant/schema change. The route
  // uses its normal restricted service-role RPCs, not this inspector.
  function inspect<T>(sql: string): T {
    if (process.env.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:54321"
      || process.env.SUPABASE_INTERNAL_URL) throw new Error("Refuse non-local inspector");
    return JSON.parse(execFileSync("docker", [
      "--context", "colima-nailiq-p0-503", "exec", "supabase_db_nailiq-day5-20260924",
      "psql", "-U", "postgres", "-d", "postgres", "-X", "-A", "-t",
      "-v", "ON_ERROR_STOP=1", "-c", sql,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as T;
  }
  function sid() {
    const value = "SM" + createHash("sha256").update("synthetic-callback-" + ++sequence).digest("hex").slice(0, 32);
    ownedSids.add(value);
    return value;
  }
  function attemptRow(id: string) {
    if (!uuid.test(id)) throw new Error("Invalid synthetic attempt identifier");
    return inspect<Record<string, unknown>>(
      "SELECT row_to_json(a) FROM (SELECT status, provider_message_sid, error_code, " +
      "delivered_at, failed_at, completed_at, updated_at FROM public.sms_delivery_attempts " +
      "WHERE id = '" + id + "'::uuid) a",
    );
  }
  async function notifications() {
    const result = await db.from("booking_notifications").select("id,status,twilio_message_sid,error_code,delivered_at,failed_at")
      .eq("salon_id", salon);
    expect(result.error).toBeNull();
    return result.data ?? [];
  }
  async function receipts() {
    const result = await db.from("twilio_message_status_receipts" as never)
      .select("message_sid,terminal_status,error_code,received_at,applied_at,notification_id,conflict_status")
      .in("message_sid", [...ownedSids]);
    expect(result.error).toBeNull();
    return result.data ?? [];
  }
  function request(url: string, fields: Record<string, string>, signedUrl = url, token = "synthetic-local-callback-token") {
    const signature = createHmac("sha1", token).update(signedUrl +
      Object.keys(fields).sort().map(key => key + fields[key]).join("")).digest("base64");
    return new NextRequest(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
        "x-forwarded-host": "127.0.0.1:3117",
        "x-forwarded-proto": "http",
      },
      body: new URLSearchParams(fields).toString(),
    });
  }
  async function invoke(attemptId: string, messageSid: string, status = "delivered", extraQuery = "", errorCode?: string) {
    return POST(request(callbackBase + "?sms_attempt_id=" + attemptId + extraQuery, {
      MessageSid: messageSid, MessageStatus: status, ...(errorCode ? { ErrorCode: errorCode } : {}),
    }));
  }
  async function claim(accepted = true) {
    const messageSid = sid();
    const result = await claimSmsDeliveryAttempt({
      salonId: salon, notificationType: "waitlist_invite",
      recipientE164: "+16045550101", body: "Synthetic callback test only",
    });
    if (!result) throw new Error("Local attempt claim failed");
    if (accepted) expect(await completeSmsDeliveryAttempt({
      ...result, status: "accepted", providerMessageSid: messageSid,
    })).toBe(true);
    return { ...result, messageSid };
  }
  async function insertNotification(messageSid: string | null, review = false, id?: string) {
    const result = await db.from("booking_notifications").insert({
      ...(id ? { id } : {}), salon_id: salon, booking_id: null,
      notification_type: review ? "review_request" : "waitlist_invite",
      channel: "sms", status: messageSid ? "sent" : "sending",
      twilio_message_sid: messageSid,
    }).select("id").single();
    expect(result.error).toBeNull();
    if (!result.data) throw new Error("Local notification fixture missing");
    return result.data.id;
  }

  beforeAll(async () => {
    if (process.env.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:54321"
      || process.env.SUPABASE_INTERNAL_URL
      || process.env.NAILIQ_DISPOSABLE_DB !== "1") throw new Error("Refuse non-local callback target");
    const counts = inspect<Record<string, number>>("SELECT json_build_object(" +
      "'salons',(select count(*) from public.salons)," +
      "'attempts',(select count(*) from public.sms_delivery_attempts)," +
      "'receipts',(select count(*) from public.twilio_message_status_receipts))");
    expect(Object.values(counts).every(count => count === 0)).toBe(true);
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== "http://127.0.0.1:54321") {
        outsideAttempts++; throw new Error("Non-local network forbidden");
      }
      return originalFetch(input, init);
    });
    db = createServiceRoleClient();
    const result = await db.from("salons").insert({
      id: salon, slug: "e2e-sms-callback-local", name: "E2E local callback",
      phone: "+16045550100", timezone: "America/Vancouver", is_beta: true,
    });
    expect(result.error).toBeNull();
    ownsSalon = true;
  });
  beforeEach(async () => {
    expect((await db.from("booking_notifications").delete().eq("salon_id", salon)).error).toBeNull();
    if (ownedSids.size) expect((await db.from("twilio_message_status_receipts" as never)
      .delete().in("message_sid", [...ownedSids])).error).toBeNull();
  });
  afterEach(() => { expect(outsideAttempts).toBe(0); });
  afterAll(async () => {
    try {
      if (ownedSids.size) expect((await db.from("twilio_message_status_receipts" as never)
        .delete().in("message_sid", [...ownedSids])).error).toBeNull();
      if (ownsSalon) expect((await db.from("salons").delete().eq("id", salon)).error).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it("persists a genuinely signed terminal callback to both real ledgers", async () => {
    const a = await claim(); const notificationId = await insertNotification(a.messageSid);
    expect((await invoke(a.attemptId, a.messageSid, "delivered", "&sms_domain_callback=1")).status).toBe(200);
    expect(attemptRow(a.attemptId)).toMatchObject({ status: "delivered", provider_message_sid: a.messageSid });
    expect(await notifications()).toEqual([expect.objectContaining({ id: notificationId, status: "delivered" })]);
    expect(await receipts()).toEqual([expect.objectContaining({ message_sid: a.messageSid, terminal_status: "delivered", notification_id: notificationId })]);
  });
  it("preserves original timestamps and one receipt on exact replay", async () => {
    const a = await claim(); await insertNotification(a.messageSid);
    expect((await invoke(a.attemptId, a.messageSid, "delivered", "&sms_domain_callback=1")).status).toBe(200);
    const before = { attempt: attemptRow(a.attemptId), receipts: await receipts(), notifications: await notifications() };
    expect((await invoke(a.attemptId, a.messageSid, "delivered", "&sms_domain_callback=1")).status).toBe(200);
    expect({ attempt: attemptRow(a.attemptId), receipts: await receipts(), notifications: await notifications() }).toEqual(before);
  });
  it("serializes parallel replay without duplicate domain rows", async () => {
    const a = await claim(); await insertNotification(a.messageSid);
    const responses = await Promise.all([invoke(a.attemptId, a.messageSid, "delivered", "&sms_domain_callback=1"),
      invoke(a.attemptId, a.messageSid, "delivered", "&sms_domain_callback=1")]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(await receipts()).toHaveLength(1); expect(await notifications()).toHaveLength(1);
    expect(attemptRow(a.attemptId)).toMatchObject({ status: "delivered" });
  });
  it("rejects a wrong HMAC without any receipt or terminal transition", async () => {
    const a = await claim(); const url = callbackBase + "?sms_attempt_id=" + a.attemptId;
    expect((await POST(request(url, { MessageSid: a.messageSid, MessageStatus: "delivered" }, url, "wrong-synthetic-token"))).status).toBe(403);
    expect(attemptRow(a.attemptId)).toMatchObject({ status: "accepted" }); expect(await receipts()).toEqual([]);
  });
  it("rejects query correlation tampering covered by the real HMAC", async () => {
    const a = await claim(); const b = await claim();
    const signed = callbackBase + "?sms_attempt_id=" + a.attemptId;
    const altered = callbackBase + "?sms_attempt_id=" + b.attemptId;
    expect((await POST(request(altered, { MessageSid: a.messageSid, MessageStatus: "delivered" }, signed))).status).toBe(403);
    expect(attemptRow(a.attemptId).status).toBe("accepted"); expect(attemptRow(b.attemptId).status).toBe("accepted");
  });
  it("rejects a signed SID mismatch without changing either ledger", async () => {
    const a = await claim(); await insertNotification(a.messageSid);
    expect((await invoke(a.attemptId, sid(), "delivered", "&sms_domain_callback=1")).status).toBe(409);
    expect(attemptRow(a.attemptId).status).toBe("accepted");
    expect((await notifications())[0].status).toBe("sent"); expect(await receipts()).toEqual([]);
  });
  it("records a signed failure and error code durably", async () => {
    const a = await claim(); await insertNotification(a.messageSid);
    expect((await invoke(a.attemptId, a.messageSid, "failed", "&sms_domain_callback=1", "30003")).status).toBe(200);
    expect(attemptRow(a.attemptId)).toMatchObject({ status: "failed", error_code: "30003" });
    expect((await notifications())[0]).toMatchObject({ status: "failed", error_code: "30003" });
  });
  it("never rewrites first terminal truth on a conflicting callback", async () => {
    const a = await claim(); await insertNotification(a.messageSid);
    expect((await invoke(a.attemptId, a.messageSid, "delivered", "&sms_domain_callback=1")).status).toBe(200);
    const before = { attempt: attemptRow(a.attemptId), receipts: await receipts(), notifications: await notifications() };
    expect((await invoke(a.attemptId, a.messageSid, "failed", "&sms_domain_callback=1", "30003")).status).toBe(409);
    expect({ attempt: attemptRow(a.attemptId), receipts: await receipts(), notifications: await notifications() }).toEqual(before);
  });
  it("retains a legacy early callback then drains it when SID correlation arrives", async () => {
    const messageSid = sid();
    expect((await POST(request(callbackBase, { MessageSid: messageSid, MessageStatus: "delivered" }))).status).toBe(200);
    expect(await receipts()).toEqual([expect.objectContaining({ terminal_status: "delivered", applied_at: null })]);
    const id = await insertNotification(messageSid);
    expect(await notifications()).toEqual([expect.objectContaining({ id, status: "delivered" })]);
    expect(await receipts()).toEqual([expect.objectContaining({ notification_id: id, applied_at: expect.any(String) })]);
  });
  it("keeps an early universal callback stronger than a later acceptance response", async () => {
    const a = await claim(false);
    expect((await invoke(a.attemptId, a.messageSid)).status).toBe(200);
    const before = attemptRow(a.attemptId);
    expect(await completeSmsDeliveryAttempt({ ...a, status: "accepted", providerMessageSid: a.messageSid })).toBe(true);
    expect(attemptRow(a.attemptId)).toEqual(before);
  });
  it("binds an early review callback and does not regress after completion", async () => {
    const a = await claim(false); const id = await insertNotification(null, true);
    expect((await invoke(a.attemptId, a.messageSid, "delivered", "&notification_id=" + id)).status).toBe(200);
    expect((await notifications())[0]).toMatchObject({ status: "delivered", twilio_message_sid: a.messageSid });
    expect(await completeReviewRequestSmsNotification({ notificationId: id, status: "sent", providerMessageId: a.messageSid })).toBe(true);
    expect((await notifications())[0].status).toBe("delivered");
  });
  it("recovers the domain on retry after only the universal receipt committed", async () => {
    const a = await claim(); const id = "30260930-0000-4000-8000-000000000002";
    const query = "&notification_id=" + id;
    expect((await invoke(a.attemptId, a.messageSid, "delivered", query)).status).toBe(503);
    const before = attemptRow(a.attemptId); expect(before.status).toBe("delivered");
    await insertNotification(null, true, id);
    expect((await invoke(a.attemptId, a.messageSid, "delivered", query)).status).toBe(200);
    expect(attemptRow(a.attemptId)).toEqual(before);
    expect((await notifications())[0].status).toBe("delivered"); expect(await receipts()).toHaveLength(1);
  });
  it("does not acknowledge an unknown universal attempt", async () => {
    const id = "30260930-0000-4000-8000-000000000003";
    expect((await invoke(id, sid())).status).toBe(503); expect(await receipts()).toEqual([]);
  });
  it("does not invent terminal truth for a signed nonterminal lifecycle state", async () => {
    const a = await claim(); await insertNotification(a.messageSid);
    expect((await invoke(a.attemptId, a.messageSid, "sent", "&sms_domain_callback=1")).status).toBe(200);
    expect(attemptRow(a.attemptId).status).toBe("accepted");
    expect((await notifications())[0].status).toBe("sent"); expect(await receipts()).toEqual([]);
  });
  it("keeps raw attempt rows and receipt RPCs inaccessible to browser roles", () => {
    const result = inspect<Record<string, boolean>>("SELECT json_build_object(" +
      "'anon_raw',has_table_privilege('anon','public.sms_delivery_attempts','SELECT')," +
      "'authenticated_raw',has_table_privilege('authenticated','public.sms_delivery_attempts','SELECT')," +
      "'service_raw',has_table_privilege('service_role','public.sms_delivery_attempts','SELECT')," +
      "'anon_rpc',has_function_privilege('anon','public.record_sms_delivery_attempt_receipt(uuid,text,text,text)','EXECUTE')," +
      "'authenticated_rpc',has_function_privilege('authenticated','public.record_sms_delivery_attempt_receipt(uuid,text,text,text)','EXECUTE')," +
      "'service_rpc',has_function_privilege('service_role','public.record_sms_delivery_attempt_receipt(uuid,text,text,text)','EXECUTE'))");
    expect(result).toEqual({ anon_raw: false, authenticated_raw: false, service_raw: false,
      anon_rpc: false, authenticated_rpc: false, service_rpc: true });
  });
});
