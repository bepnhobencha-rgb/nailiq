import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ email: vi.fn(), groupEmail: vi.fn(), sms: vi.fn(), suppression: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/noshow/generateReminderToken", () => ({ generateReminderToken: async () => ({ id: "synthetic-local-token" }) }));
vi.mock("@/shared/noshow/sendReminderEmail", () => ({ sendReminderEmail: mocks.email, sendGroupReminderEmail: mocks.groupEmail }));
vi.mock("@/shared/lib/twilioSms", () => ({ sendSmsReminder: mocks.sms }));
vi.mock("@/shared/lib/notificationLog", () => ({ logNotification: async () => {} }));
vi.mock("@/shared/security/cronRunHistory", () => ({ runTrackedCron: (_name: string, work: () => Promise<Response>) => work() }));
vi.mock("@/shared/notifications/customerEmailDeliverySuppression", () => ({ customerEmailDeliverySuppressionReason: mocks.suppression }));

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { claimReminderDelivery, completeReminderDelivery } from "@/shared/reminders/reminderDeliveryClaims";
import { GET } from "./route";

const enabled = process.env.NAILIQ_LOCAL_REMINDER_INTEGRATION === "1";
const salon = "19260925-0000-4000-8000-000000000001";
const service = "19260925-0000-4000-8000-000000000002";
const staff = "19260925-0000-4000-8000-000000000003";
const booking = "19260925-0000-4000-8000-000000000004";
const memberStaff = "19260925-0000-4000-8000-000000000005";
const memberBooking = "19260925-0000-4000-8000-000000000006";
const group = "19260925-0000-4000-8000-000000000007";
const category = "e2e-reminder-local-integration";

// Explicit opt-in only. Default CI never connects this suite to any database.
describe.skipIf(!enabled)("local PostgreSQL reminder recovery, providers mocked", () => {
  let db: ReturnType<typeof createServiceRoleClient>;
  let outsideAttempts = 0;
  let start = "2026-09-26T00:00:00.000Z";
  let ownsSalon = false;
  let ownsCategory = false;
  beforeAll(async () => {
    if (process.env.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:54321"
      || process.env.SUPABASE_INTERNAL_URL) throw new Error("Refuse non-local integration target");
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== "http://127.0.0.1:54321") {
        outsideAttempts++; throw new Error("Non-local network forbidden");
      }
      return originalFetch(input, init);
    });
    db = createServiceRoleClient();
    const existing = await db.from("salons").select("id", { count: "exact", head: true });
    expect(existing.error).toBeNull(); expect(existing.count).toBe(0);
    expect((await db.from("service_categories").insert({ slug: category, name_en: "Synthetic", name_vi: "Synthetic" })).error).toBeNull();
    ownsCategory = true;
    expect((await db.from("salons").insert({ id: salon, slug: category, name: "E2E local reminder", phone: "+16045550101", timezone: "America/Vancouver", is_beta: true,
      subscription_status: "active", reminders_enabled: true, reminder_24h_enabled: true, reminder_3h_enabled: true,
      sms_reminders_enabled: true, sms_outbound_enabled: true, email_outbound_enabled: true, sms_a2p_registered: true,
    })).error).toBeNull();
    ownsSalon = true;
    expect((await db.from("services").insert({ id: service, salon_id: salon, name: "Synthetic", price_cents: 2500, duration_minutes: 30, category })).error).toBeNull();
    expect((await db.from("staff").insert({ id: staff, salon_id: salon, name: "Synthetic", status: "active" })).error).toBeNull();
    expect((await db.from("staff").insert({ id: memberStaff, salon_id: salon, name: "Synthetic member staff", status: "active" })).error).toBeNull();
  });
  beforeEach(async () => {
    vi.resetAllMocks(); vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T00:30:00.000Z"));
    vi.stubEnv("CRON_SECRET", "synthetic-local-cron");
    mocks.email.mockResolvedValue({ ok: true, messageId: "synthetic-local-message" });
    mocks.groupEmail.mockResolvedValue({ ok: true, messageId: "synthetic-local-group-message" });
    mocks.sms.mockImplementation(() => { throw new Error("Unexpected SMS dispatch"); });
    mocks.suppression.mockResolvedValue(null);
    expect((await db.from("booking_reminder_delivery_claims" as never).delete().eq("salon_id", salon)).error).toBeNull();
    expect((await db.from("booking_notifications").delete().eq("salon_id", salon)).error).toBeNull();
    expect((await db.from("bookings").delete().in("id", [booking, memberBooking]).eq("salon_id", salon)).error).toBeNull();
    start = "2026-09-26T00:00:00.000Z";
    expect((await db.from("bookings").insert({ id: booking, salon_id: salon, service_id: service, staff_id: staff,
      client_name: "Synthetic", client_phone: "16045550102", client_email: "qa@example.invalid",
      start_time_utc: start, end_time_utc: "2026-09-26T00:30:00.000Z", status: "confirmed", price_cents: 2500,
    })).error).toBeNull();
  });
  afterEach(() => {
    expect(outsideAttempts).toBe(0); expect(mocks.sms).not.toHaveBeenCalled();
    vi.useRealTimers(); vi.unstubAllEnvs();
  });
  afterAll(async () => {
    try {
      if (ownsSalon) expect((await db.from("salons").delete().eq("id", salon)).error).toBeNull();
      if (ownsCategory) expect((await db.from("service_categories").delete().eq("slug", category)).error).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  async function failClaim(kind: "24h" | "3h" = "24h", status: "failed" | "unknown" = "failed", target = booking, channel: "email" | "sms" = "email") {
    const claim = await claimReminderDelivery({ salonId: salon, bookingId: target,
      appointmentStartUtc: start, reminderType: kind, channel });
    if (!claim.ok || !claim.claimed) throw new Error("Local fixture claim failed");
    expect(await completeReminderDelivery({ claimId: claim.claimId, status,
      errorCode: status === "failed" ? "delivery_preflight_or_rejection_failed" : "provider_outcome_unknown" })).toBe(true);
  }
  const invoke = () => GET(new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Bearer synthetic-local-cron" } }));
  async function receipt(target = booking) {
    const result = await db.from("booking_reminder_delivery_claims" as never).select("status,attempt_count,provider_message_id").eq("booking_id", target).single();
    expect(result.error).toBeNull(); return result.data;
  }
  it.each(["24h", "3h"] as const)("selects and settles the real %s failed claim once", async (kind) => {
    if (kind === "3h") {
      start = "2026-09-25T03:00:00.000Z";
      expect((await db.from("bookings").update({ start_time_utc: start, end_time_utc: "2026-09-25T03:30:00.000Z" }).eq("id", booking)).error).toBeNull();
    }
    await failClaim(kind);
    const response = await invoke(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ errors: 0, recoverySettled: 1 });
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(await receipt()).toMatchObject({ status: "sent", attempt_count: 2, provider_message_id: "synthetic-local-message" });
    await invoke(); expect(mocks.email).toHaveBeenCalledOnce();
  });
  it("allows just one mocked send when two real workers race", async () => {
    await failClaim();
    const responses = await Promise.all([invoke(), invoke()]);
    for (const response of responses) expect(response.status).toBe(200);
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(await receipt()).toMatchObject({ status: "sent", attempt_count: 2 });
  });
  it("caps repeated rejection at three total attempts", async () => {
    await failClaim(); mocks.email.mockResolvedValue({ ok: false, error: "resend_429" });
    await invoke(); await invoke(); await invoke();
    expect(mocks.email).toHaveBeenCalledTimes(2);
    expect(await receipt()).toMatchObject({ status: "failed", attempt_count: 3 });
  });
  it("does not send after the deadline", async () => {
    await failClaim(); vi.setSystemTime(new Date("2026-09-25T01:00:00.001Z"));
    await invoke(); expect(mocks.email).not.toHaveBeenCalled();
    expect(await receipt()).toMatchObject({ status: "failed", attempt_count: 1 });
  });
  it("includes the exact 60-minute deadline in the real query", async () => {
    await failClaim(); vi.setSystemTime(new Date("2026-09-25T01:00:00.000Z"));
    const response = await invoke(); expect(response.status).toBe(200);
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(await receipt()).toMatchObject({ status: "sent", attempt_count: 2 });
  });
  it("never reclaims an unknown provider outcome from the real ledger", async () => {
    await failClaim("24h", "unknown");
    await invoke(); expect(mocks.email).not.toHaveBeenCalled();
    expect(await receipt()).toMatchObject({ status: "unknown", attempt_count: 1 });
  });
  it("honors cancellation in the real hydrated booking", async () => {
    await failClaim();
    expect((await db.from("bookings").update({ status: "cancelled" }).eq("id", booking)).error).toBeNull();
    await invoke(); expect(mocks.email).not.toHaveBeenCalled();
  });
  it("does not send an old occurrence after rescheduling", async () => {
    await failClaim();
    expect((await db.from("bookings").update({ start_time_utc: "2026-09-28T00:00:00Z", end_time_utc: "2026-09-28T00:30:00Z" }).eq("id", booking)).error).toBeNull();
    await invoke(); expect(mocks.email).not.toHaveBeenCalled();
  });
  it("settles suppression without a mocked send", async () => {
    await failClaim(); mocks.suppression.mockResolvedValue("unsubscribed");
    await invoke(); expect(mocks.email).not.toHaveBeenCalled();
    expect(await receipt()).toMatchObject({ status: "suppressed", attempt_count: 2 });
  });

  async function seedGroup() {
    expect((await db.from("bookings").update({ group_id: group, is_group_organizer: true, group_size: 2 }).eq("id", booking)).error).toBeNull();
    expect((await db.from("bookings").insert({ id: memberBooking, salon_id: salon, service_id: service, staff_id: memberStaff,
      client_name: "Synthetic member", client_phone: "16045550103", client_email: "member@example.invalid",
      start_time_utc: start, end_time_utc: "2026-09-26T00:30:00.000Z", status: "confirmed", price_cents: 2500,
      group_id: group, is_group_organizer: false, group_size: 2,
    })).error).toBeNull();
  }
  async function groupClaims() {
    const result = await db.from("booking_reminder_delivery_claims" as never).select("booking_id,status,attempt_count").eq("salon_id", salon);
    expect(result.error).toBeNull(); return result.data;
  }
  it("recovers only the organizer claim without member fanout or shared markers", async () => {
    await seedGroup(); await failClaim();
    const response = await invoke(); expect(response.status).toBe(200);
    expect(mocks.groupEmail).toHaveBeenCalledOnce(); expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.groupEmail).toHaveBeenCalledWith(expect.objectContaining({ organizerEmail: "qa@example.invalid",
      members: expect.arrayContaining([expect.objectContaining({ bookingId: booking }), expect.objectContaining({ bookingId: memberBooking })]),
    }));
    expect(Date.parse(mocks.groupEmail.mock.calls[0][0].recoveryStartTimeUtc)).toBe(Date.parse(start));
    expect(await groupClaims()).toEqual([expect.objectContaining({ booking_id: booking, status: "sent", attempt_count: 2 })]);
    const markers = await db.from("bookings").select("reminder_24h_sent_at").eq("salon_id", salon);
    expect(markers.error).toBeNull(); expect(markers.data).toEqual([{ reminder_24h_sent_at: null }, { reminder_24h_sent_at: null }]);
    await invoke(); expect(mocks.groupEmail).toHaveBeenCalledOnce();
  });
  it("recovers a member despite a shared marker without resending the organizer", async () => {
    await seedGroup(); await failClaim("24h", "failed", memberBooking);
    expect((await db.from("bookings").update({ reminder_24h_sent_at: "2026-09-25T00:00:00Z" }).eq("salon_id", salon)).error).toBeNull();
    const response = await invoke(); expect(response.status).toBe(200);
    expect(mocks.groupEmail).not.toHaveBeenCalled(); expect(mocks.email).toHaveBeenCalledOnce();
    expect(mocks.email).toHaveBeenCalledWith(expect.objectContaining({ clientEmail: "member@example.invalid", deterministicCopy: true }));
    expect(await groupClaims()).toEqual([expect.objectContaining({ booking_id: memberBooking, status: "sent", attempt_count: 2 })]);
    await invoke(); expect(mocks.email).toHaveBeenCalledOnce();
  });
  it("settles organizer and member independently exactly once across concurrent workers", async () => {
    await seedGroup(); await failClaim(); await failClaim("24h", "failed", memberBooking);
    for (const response of await Promise.all([invoke(), invoke()])) expect(response.status).toBe(200);
    expect(mocks.groupEmail).toHaveBeenCalledOnce(); expect(mocks.email).toHaveBeenCalledOnce();
    expect(await receipt()).toMatchObject({ status: "sent", attempt_count: 2 });
    expect(await receipt(memberBooking)).toMatchObject({ status: "sent", attempt_count: 2 });
  });
  it("does not introduce SMS recovery for a group member", async () => {
    await seedGroup(); await failClaim("24h", "failed", memberBooking, "sms");
    const response = await invoke(); expect(response.status).toBe(200);
    expect(mocks.email).not.toHaveBeenCalled(); expect(mocks.groupEmail).not.toHaveBeenCalled();
    expect(await receipt(memberBooking)).toMatchObject({ status: "failed", attempt_count: 1 });
  });
});
