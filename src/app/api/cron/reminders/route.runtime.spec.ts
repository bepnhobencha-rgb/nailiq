import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(), email: vi.fn(), sms: vi.fn(), token: vi.fn(),
  claim: vi.fn(), complete: vi.fn(), suppression: vi.fn(), log: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({ from: mocks.from }) }));
vi.mock("@/shared/noshow/generateReminderToken", () => ({ generateReminderToken: mocks.token }));
vi.mock("@/shared/noshow/sendReminderEmail", () => ({ sendReminderEmail: mocks.email, sendGroupReminderEmail: mocks.email }));
vi.mock("@/shared/lib/twilioSms", () => ({ sendSmsReminder: mocks.sms }));
vi.mock("@/shared/lib/notificationLog", () => ({ logNotification: mocks.log }));
vi.mock("@/shared/verticals/registry", () => ({ resolveVertical: () => ({ aiDescriptor: "salon" }) }));
vi.mock("@/shared/ai/agentPermissionFence", () => ({ isAiAgentPermissionEnabled: () => false }));
vi.mock("@/shared/ai/usageLedger", () => ({ isProviderTimeoutError: () => false }));
vi.mock("@/shared/security/cronRunHistory", () => ({ runTrackedCron: (_name: string, work: () => Promise<Response>) => work() }));
vi.mock("@/shared/subscriptions/tenantEntitlements", () => ({ resolveTenantEntitlements: () => ({ canSendTransactionalReminder: true }) }));
vi.mock("@/shared/notifications/customerEmailDeliverySuppression", () => ({ customerEmailDeliverySuppressionReason: mocks.suppression }));
vi.mock("@/shared/reminders/reminderDeliveryClaims", async (original) => ({
  ...await original<typeof import("@/shared/reminders/reminderDeliveryClaims")>(),
  claimReminderDelivery: mocks.claim, completeReminderDelivery: mocks.complete,
}));

import { GET } from "./route";

const fixture = {
  id: "synthetic-booking", salon_id: "synthetic-salon", client_name: "QA",
  client_email: "qa@example.invalid", client_phone: "16045550123",
  start_time_utc: "2026-09-26T00:00:00.000Z", created_at: "2026-09-20T00:00:00Z",
  status: "confirmed", group_id: null as string | null, is_group_organizer: false, client_locale: "en",
  services: { name: "Test service" }, staff: { name: "QA staff" },
  salons: { name: "QA", slug: "e2e-reminder-runtime", timezone: "America/Vancouver",
    reminders_enabled: true, reminder_24h_enabled: true, reminder_3h_enabled: true,
    sms_reminders_enabled: true, sms_outbound_enabled: true, email_outbound_enabled: true,
    sms_a2p_registered: true, feature_flags: {}, logo_url: null },
};

describe.each(["24h", "3h"] as const)("reminder %s runtime without network or real providers", (kind) => {
  let update: ReturnType<typeof vi.fn>;
  let network: ReturnType<typeof vi.fn>;
  let booking: typeof fixture & Record<string, unknown>;
  let recoveryClaims: Array<Record<string, unknown>>;
  let extraBookings: Array<Record<string, unknown>>;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T00:00:00.000Z"));
    vi.stubEnv("CRON_SECRET", "synthetic-local-cron");
    network = vi.fn(() => { throw new Error("Network forbidden in runtime QA"); });
    vi.stubGlobal("fetch", network);
    update = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
    booking = { ...structuredClone(fixture), start_time_utc: kind === "24h"
      ? "2026-09-26T00:00:00.000Z" : "2026-09-25T03:00:00.000Z" };
    recoveryClaims = [];
    extraBookings = [];
    mocks.from.mockImplementation((table: string) => {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const data = () => (table === "booking_reminder_delivery_claims" ? recoveryClaims : [booking, ...extraBookings])
        .filter((row) => filters.every((filter) => filter(row)));
      const builder = {
        select: vi.fn(), in: vi.fn(), gte: vi.fn(), lte: vi.fn(),
        is: vi.fn(), eq: vi.fn(), lt: vi.fn(), order: vi.fn(), limit: vi.fn(),
        then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: data(), error: null })),
        update,
      };
      builder.select.mockReturnValue(builder);
      builder.order.mockReturnValue(builder); builder.limit.mockReturnValue(builder);
      for (const method of [builder.eq, builder.is]) method.mockImplementation((column: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) === value); return builder;
      });
      builder.in.mockImplementation((column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column])); return builder;
      });
      builder.gte.mockImplementation((column: string, value: string) => {
        filters.push((row) => Date.parse(String(row[column])) >= Date.parse(value)); return builder;
      });
      builder.lte.mockImplementation((column: string, value: string) => {
        filters.push((row) => Date.parse(String(row[column])) <= Date.parse(value)); return builder;
      });
      builder.lt.mockImplementation((column: string, value: string | number) => {
        filters.push((row) => typeof value === "number" ? Number(row[column]) < value
          : Date.parse(String(row[column])) < Date.parse(value)); return builder;
      });
      return builder;
    });
    mocks.token.mockResolvedValue({ id: "synthetic-token" });
    mocks.claim.mockImplementation(async ({ channel }: { channel: string }) => ({ ok: true, claimed: true, claimId: `synthetic-${channel}` }));
    mocks.complete.mockResolvedValue(true);
    mocks.suppression.mockResolvedValue(null);
    mocks.email.mockResolvedValue({ ok: true, messageId: "synthetic-email-receipt" });
    mocks.sms.mockResolvedValue({ ok: true, messageSid: "SM" + "a".repeat(32) });
  });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  });
  const invoke = () => {
    return GET(new Request("http://localhost/api/cron/reminders", {
      headers: { authorization: "Bearer synthetic-local-cron" },
    }));
  };

  it("marks a reminder complete when both channels finish", async () => {
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sent24h: kind === "24h" ? 1 : 0, sent3h: kind === "3h" ? 1 : 0, errors: 0 });
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({ [`reminder_${kind}_sent_at`]: "2026-09-25T00:00:00.000Z" });
  });
  it.each(["email", "sms"])("keeps %s retry eligible when only the other channel succeeds", async (channel) => {
    (channel === "email" ? mocks.email : mocks.sms).mockResolvedValue({ ok: false, error: channel === "email" ? "resend_429" : "twilio_429" });
    await invoke();
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ claimId: `synthetic-${channel}`, status: "failed" }));
    expect(update).not.toHaveBeenCalled();
  });
  it("does not hide a failed suppression lookup behind SMS success", async () => {
    mocks.suppression.mockResolvedValue("lookup_unavailable");
    await invoke();
    expect(mocks.email).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it("does not resend a successful channel while retrying the failed one", async () => {
    mocks.claim.mockImplementation(async ({ channel }: { channel: string }) => channel === "sms"
      ? { ok: true, claimed: false, status: "sent" }
      : { ok: true, claimed: true, claimId: "synthetic-email" });
    await invoke();
    expect(mocks.sms).not.toHaveBeenCalled();
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
  });
  it.each(["email", "sms"])("retries only failed %s across two worker runs", async (channel) => {
    const states = new Map<string, string>();
    mocks.claim.mockImplementation(async ({ channel: current }: { channel: string }) =>
      states.get(current) === "sent"
        ? { ok: true, claimed: false, status: "sent" }
        : { ok: true, claimed: true, claimId: `synthetic-${current}` });
    mocks.complete.mockImplementation(async ({ claimId, status }: { claimId: string; status: string }) => {
      states.set(claimId.replace("synthetic-", ""), status);
      return true;
    });
    (channel === "email" ? mocks.email : mocks.sms).mockResolvedValueOnce({ ok: false, error: channel === "email" ? "resend_429" : "twilio_429" });
    await invoke();
    expect(update).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-09-25T00:15:00.000Z"));
    await invoke();
    expect(mocks.email).toHaveBeenCalledTimes(channel === "email" ? 2 : 1);
    expect(mocks.sms).toHaveBeenCalledTimes(channel === "sms" ? 2 : 1);
    expect(update).toHaveBeenCalledOnce();
  });
  it.each(["sending", "unknown"])("leaves a %s channel untouched without hiding it", async (status) => {
    mocks.claim.mockImplementation(async ({ channel }: { channel: string }) => channel === "sms"
      ? { ok: true, claimed: false, status }
      : { ok: true, claimed: true, claimId: "synthetic-email" });
    await invoke();
    expect(mocks.sms).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it("repairs a missing marker from terminal claims without resending", async () => {
    mocks.claim.mockResolvedValue({ ok: true, claimed: false, status: "sent" });
    await invoke();
    expect(mocks.sms).not.toHaveBeenCalled();
    expect(mocks.email).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });
  it("preserves retry eligibility when claiming one channel is unavailable", async () => {
    mocks.claim.mockImplementation(async ({ channel }: { channel: string }) => channel === "email"
      ? { ok: false, error: "claim_unavailable" }
      : { ok: true, claimed: true, claimId: "synthetic-sms" });
    await invoke();
    expect(mocks.email).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it("records uncertain email outcome without falsely completing the reminder", async () => {
    mocks.email.mockRejectedValue(new Error("synthetic timeout"));
    await invoke();
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "unknown", errorCode: "provider_outcome_unknown" }));
    expect(update).not.toHaveBeenCalled();
  });
  it("settles suppressed channels without calling their provider", async () => {
    mocks.suppression.mockResolvedValue("unsubscribed");
    await invoke();
    expect(mocks.email).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });
  it("rejects unauthorized requests before any database or provider work", async () => {
    const response = await GET(new Request("http://localhost/api/cron/reminders"));
    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.sms).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "completed", "no_show"])("does not select a %s appointment", async (status) => {
    booking.status = status;
    await invoke();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.sms).not.toHaveBeenCalled();
  });
  it("does not select an occurrence rescheduled outside the due window", async () => {
    booking.start_time_utc = "2026-09-28T12:00:00.000Z";
    await invoke();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("does not select a reminder whose shared marker is already set", async () => {
    booking[`reminder_${kind}_sent_at`] = "2026-09-24T23:50:00.000Z";
    await invoke();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("never invents a late first attempt without a failed ledger claim", async () => {
    mocks.email.mockResolvedValue({ ok: false, error: "resend_429" });
    vi.setSystemTime(new Date("2026-09-25T00:15:00.000Z"));
    await invoke();
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    mocks.claim.mockClear(); mocks.email.mockClear(); mocks.sms.mockClear();
    vi.setSystemTime(new Date("2026-09-25T00:30:00.000Z"));
    const response = await invoke();
    // No failed ledger row is supplied: late first sends must remain forbidden.
    expect(await response.json()).toMatchObject({ sent24h: 0, sent3h: 0, errors: 0 });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.sms).not.toHaveBeenCalled();
  });

  function failedClaim(channel = "email") {
    return { booking_id: booking.id, salon_id: booking.salon_id,
      appointment_start_utc: booking.start_time_utc, reminder_type: kind,
      channel, status: "failed", attempt_count: 1, provider_message_id: null,
      last_error_code: "delivery_preflight_or_rejection_failed" };
  }
  it.each([30, 60])("recovers only the failed channel at %i minutes late", async (minutes) => {
    recoveryClaims = [failedClaim()];
    vi.setSystemTime(new Date(Date.parse("2026-09-25T00:00:00Z") + minutes * 60_000));
    const response = await invoke();
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(mocks.email).toHaveBeenCalledWith(expect.objectContaining({ deterministicCopy: true }));
    expect(await response.json()).toMatchObject({ recoverySettled: 1 });
    expect(mocks.sms).not.toHaveBeenCalled();
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });
  it("does not recover after the inclusive 60-minute deadline", async () => {
    recoveryClaims = [failedClaim()];
    vi.setSystemTime(new Date("2026-09-25T01:00:00.001Z"));
    await invoke();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it.each([
    { status: "unknown" }, { status: "sending" }, { status: "sent" },
    { attempt_count: 3 }, { provider_message_id: "provider-receipt" },
    { last_error_code: "provider_outcome_unknown" }, { salon_id: "other-salon" },
  ])("rejects unsafe catch-up claim %j", async (change) => {
    recoveryClaims = [{ ...failedClaim(), ...change }];
    vi.setSystemTime(new Date("2026-09-25T00:30:00Z"));
    await invoke();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("ignores the old claim after rescheduling", async () => {
    recoveryClaims = [failedClaim()];
    booking.start_time_utc = "2026-09-28T00:00:00Z";
    vi.setSystemTime(new Date("2026-09-25T00:30:00Z"));
    await invoke();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "completed", "no_show"])("does not catch up a now-%s booking", async (status) => {
    recoveryClaims = [failedClaim()]; booking.status = status;
    vi.setSystemTime(new Date("2026-09-25T00:30:00Z"));
    await invoke();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("honors newly suppressed email during recovery", async () => {
    recoveryClaims = [failedClaim()]; mocks.suppression.mockResolvedValue("unsubscribed");
    vi.setSystemTime(new Date("2026-09-25T00:30:00Z"));
    await invoke();
    expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "suppressed" }));
  });
  it("recovers a group member despite the shared marker without contacting organizer", async () => {
    booking.group_id = "synthetic-group";
    booking[`reminder_${kind}_sent_at`] = "2026-09-25T00:00:00Z";
    recoveryClaims = [failedClaim()];
    vi.setSystemTime(new Date("2026-09-25T00:30:00Z"));
    await invoke();
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(mocks.email).toHaveBeenCalledWith(expect.objectContaining({ clientEmail: booking.client_email }));
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });
  it("renders recovery SMS using the actual date/time, not a relative promise", async () => {
    recoveryClaims = [failedClaim("sms")];
    vi.setSystemTime(new Date("2026-09-25T00:30:00Z"));
    await invoke();
    expect(mocks.sms).toHaveBeenCalledOnce();
    const body = mocks.sms.mock.calls[0][1] as string;
    expect(body).toContain("2026");
    expect(body).not.toMatch(/in 3 hours|tomorrow/);
    expect(body).toContain("STOP");
    expect(mocks.email).not.toHaveBeenCalled();
  });
  it("recovers only the organizer claim without sending new member reminders", async () => {
    booking.group_id = "synthetic-group"; booking.is_group_organizer = true;
    recoveryClaims = [failedClaim()];
    vi.setSystemTime(new Date("2026-09-25T00:30:00Z"));
    const response = await invoke();
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(mocks.email).toHaveBeenCalledWith(expect.objectContaining({ organizerEmail: booking.client_email, recoveryStartTimeUtc: booking.start_time_utc }));
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ recoverySettled: 1 });
    expect(update).not.toHaveBeenCalled();
  });
  it("does not cross the provider boundary if preparation passes the deadline", async () => {
    recoveryClaims = [failedClaim()];
    vi.setSystemTime(new Date("2026-09-25T00:59:59Z"));
    mocks.suppression.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-09-25T01:00:00.001Z")); return null;
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await invoke();
      expect(response.status).toBe(500);
      expect(mocks.email).not.toHaveBeenCalled();
      expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", errorCode: "recovery_window_expired" }));
    } finally { errorLog.mockRestore(); }
  });
  it.each(["sent", "unknown", "sending", "failed"])("honors atomic claim refusal changed to %s after discovery", async (status) => {
    recoveryClaims = [failedClaim()];
    vi.setSystemTime(new Date("2026-09-25T00:30:00Z"));
    mocks.claim.mockResolvedValue({ ok: true, claimed: false, status });
    await invoke();
    expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.sms).not.toHaveBeenCalled();
  });
  it("does not let normal organizer work bypass an earlier member's deadline", async () => {
    booking.group_id = "synthetic-group"; booking.is_group_organizer = true;
    extraBookings = [{ ...structuredClone(booking), id: "early-member", is_group_organizer: false,
      client_email: "member@example.invalid",
      start_time_utc: new Date(Date.parse(booking.start_time_utc) - 2 * 3_600_000).toISOString() }];
    const response = await invoke();
    expect(mocks.email).toHaveBeenCalledOnce();
    expect(mocks.email).toHaveBeenCalledWith(expect.objectContaining({ organizerEmail: booking.client_email }));
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ errors: 1 });
  });
});
