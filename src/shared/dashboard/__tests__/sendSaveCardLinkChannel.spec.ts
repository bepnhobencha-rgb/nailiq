import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ ctx: vi.fn(), token: vi.fn(), sms: vi.fn(), email: vi.fn(), draft: vi.fn(), query: vi.fn(), eq: vi.fn(), claim: vi.fn(), complete: vi.fn() }));
vi.mock("@/shared/notifications/cardRetryEmailReceipt", () => ({ claimCardRetryEmail: m.claim, completeCardRetryEmail: m.complete }));
vi.mock("@/shared/dashboard/setupActions", () => ({ getDashboardWriteClient: m.ctx }));
vi.mock("@/shared/noshow/generateReminderToken", () => ({ generateReminderToken: m.token }));
vi.mock("@/shared/lib/twilioSms", () => ({ sendSmsReminder: m.sms }));
vi.mock("@/shared/lib/sendCustomerLinkEmail", () => ({ sendCustomerLinkEmail: m.email }));
vi.mock("@/shared/lib/smsTemplateRegistry", () => ({ buildSaveCardSms: () => "synthetic" }));
vi.mock("@/shared/noshow/agentNoShowPolicy", () => ({ draftSaveCardMessages: m.draft }));
import { sendSaveCardLink } from "../sendSaveCardLinkAction";

const booking = { id: "booking-1", client_name: "Synthetic", client_phone: "+16045550100", client_email: "guest@example.invalid", status: "confirmed", deleted_at: null, start_time_utc: "2099-01-01T12:00:00Z", noshow_card_required: true, noshow_card_id: null, card_protection_status: "retry_required" };
let context: Record<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  const q = { select: vi.fn().mockReturnThis(), eq: m.eq.mockReturnThis(), maybeSingle: m.query };
  context = { role: "owner", userId: "actor-1", entitlements: { canRunMarketing: true }, supabase: { from: () => q },
    salon: { id: "salon-1", name: "Synthetic", noshow_protection_enabled: true, email_links_enabled: true,
      feature_flags: { ai_noshow_policy_live: true } } };
  m.ctx.mockResolvedValue(context);
  m.query.mockResolvedValue({ data: booking });
  m.token.mockResolvedValue({ id: "synthetic-token" });
  m.email.mockResolvedValue({ ok: true, providerMessageId: "synthetic-id" });
  m.sms.mockResolvedValue({ ok: true });
  m.claim.mockResolvedValue({ id: "receipt-1", attemptId: "attempt-1", salonId: "salon-1" });
  m.complete.mockResolvedValue(true);
});
describe("save-card email-only boundary", () => {
  it("blocks reload retries before capability creation or send", async () => {
    m.claim.mockResolvedValue(null);
    expect(await sendSaveCardLink("synthetic", { bookingId: booking.id, channel: "email_only" })).toEqual({ ok: false, error: "email_retry_blocked" });
    expect(m.claim).toHaveBeenCalledWith({ salonId: "salon-1", bookingId: "booking-1", actorId: "actor-1", email: booking.client_email });
    expect(m.token).not.toHaveBeenCalled(); expect(m.email).not.toHaveBeenCalled();
  });
  it("only the shared guard winner can send concurrent requests", async () => {
    m.claim.mockResolvedValueOnce({ id: "receipt-1", attemptId: "attempt-1", salonId: "salon-1" }).mockResolvedValue(null);
    const results = await Promise.all(Array.from({ length: 8 }, () => sendSaveCardLink("synthetic", { bookingId: booking.id, channel: "email_only" })));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(m.email).toHaveBeenCalledOnce(); expect(m.token).toHaveBeenCalledOnce();
  });
  it.each([
    { status: "cancelled" }, { deleted_at: "2026-01-01" }, { start_time_utc: "2000-01-01" },
    { start_time_utc: "invalid" }, { noshow_card_required: false }, { noshow_card_id: "saved-card" },
    { card_protection_status: "reconciliation_pending" }, { card_protection_status: "saving" },
  ])("does not send for an ineligible booking %j", async (override) => {
    m.query.mockResolvedValue({ data: { ...booking, ...override } });
    expect(await sendSaveCardLink("synthetic", { bookingId: booking.id, channel: "email_only" })).toEqual({ ok: false, error: "invalid_booking" });
    expect(m.token).not.toHaveBeenCalled(); expect(m.email).not.toHaveBeenCalled();
  });
  it("sends only email, uses tenant scope, and never invokes SMS or AI", async () => {
    const result = await sendSaveCardLink("synthetic", { bookingId: booking.id, channel: "email_only", language: "en" });
    expect(result).toMatchObject({ ok: true, emailSent: true });
    expect(m.eq).toHaveBeenCalledWith("salon_id", "salon-1");
    expect(m.email).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ email: booking.client_email, bodyText: expect.stringContaining("does not charge") }));
    expect(m.sms).not.toHaveBeenCalled(); expect(m.draft).not.toHaveBeenCalled();
  });
  it("rejects conflicting channel flags without minting or sending", async () => {
    expect(await sendSaveCardLink("synthetic", { bookingId: booking.id, channel: "email_only", sendSms: true })).toEqual({ ok: false, error: "invalid_channel" });
    expect(m.token).not.toHaveBeenCalled(); expect(m.sms).not.toHaveBeenCalled(); expect(m.email).not.toHaveBeenCalled();
  });
  it("rejects an invalid channel at runtime", async () => {
    expect(await sendSaveCardLink("synthetic", { bookingId: booking.id, channel: "fax" as "email_only" })).toEqual({ ok: false, error: "invalid_channel" });
  });
  it("missing email does not fall back to phone", async () => {
    m.query.mockResolvedValue({ data: { ...booking, client_email: " " } });
    expect(await sendSaveCardLink("synthetic", { bookingId: booking.id, channel: "email_only" })).toEqual({ ok: false, error: "no_email" });
    expect(m.sms).not.toHaveBeenCalled(); expect(m.token).not.toHaveBeenCalled();
  });
  it("respects disabled salon email", async () => {
    context.salon = { id: "salon-1", noshow_protection_enabled: true, email_links_enabled: false };
    expect(await sendSaveCardLink("synthetic", { bookingId: booking.id, channel: "email_only" })).toEqual({ ok: false, error: "email_disabled" });
    expect(m.token).not.toHaveBeenCalled();
  });
  it.each(["failed", "throws"])("does not report success when email %s", async (mode) => {
    if (mode === "failed") m.email.mockResolvedValue({ ok: false });
    else m.email.mockRejectedValue(new Error("synthetic"));
    expect(await sendSaveCardLink("synthetic", { bookingId: booking.id, channel: "email_only" })).toEqual({ ok: false, error: "email_send_failed" });
    expect(m.sms).not.toHaveBeenCalled();
  });
  it("preserves legacy SMS plus email behavior", async () => {
    expect(await sendSaveCardLink("synthetic", { bookingId: booking.id, sendSms: true })).toMatchObject({ ok: true, smsSent: true, emailSent: true });
    expect(m.sms).toHaveBeenCalledOnce(); expect(m.email).toHaveBeenCalledOnce();
  });
  it("does not report success when receipt persistence fails after provider acceptance", async () => {
    m.complete.mockResolvedValue(false);
    expect(await sendSaveCardLink("synthetic", { bookingId: booking.id, channel: "email_only" })).toEqual({ ok: false, error: "email_send_failed" });
    expect(m.email).toHaveBeenCalledOnce();
    expect(m.complete).toHaveBeenCalledWith(expect.anything(), "synthetic-id");
  });
  it("requires a receipt ID and never treats an empty provider success as delivered", async () => {
    m.email.mockResolvedValue({ ok: true });
    expect(await sendSaveCardLink("synthetic", { bookingId: booking.id, channel: "email_only" })).toEqual({ ok: false, error: "email_send_failed" });
  });
  it("generate-only sends nothing", async () => {
    expect(await sendSaveCardLink("synthetic", { bookingId: booking.id })).toMatchObject({ ok: true });
    expect(m.sms).not.toHaveBeenCalled(); expect(m.email).not.toHaveBeenCalled();
  });
  it.each(["unauthorized", "forbidden", "invalid_booking"])("rejects %s", async (reason) => {
    if (reason === "unauthorized") m.ctx.mockResolvedValue(null);
    if (reason === "forbidden") context.role = "nail_tech";
    if (reason === "invalid_booking") m.query.mockResolvedValue({ data: null });
    expect(await sendSaveCardLink("synthetic", { bookingId: booking.id, channel: "email_only" })).toEqual({ ok: false, error: reason });
    expect(m.token).not.toHaveBeenCalled(); expect(m.email).not.toHaveBeenCalled();
  });
});
