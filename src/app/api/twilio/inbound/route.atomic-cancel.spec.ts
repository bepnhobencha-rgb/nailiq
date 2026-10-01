import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), signature: vi.fn(), log: vi.fn(), audit: vi.fn(),
  after: vi.fn(), deliver: vi.fn(), consent: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => ({
  ...await original<typeof import("next/server")>(), after: mocks.after,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock("@/shared/lib/twilioSignature", () => ({
  getTwilioAuthToken: async () => "synthetic-token",
  validateTwilioSignature: mocks.signature,
  twilioRequestBaseUrl: () => "https://nailiq.test",
}));
vi.mock("@/shared/lib/notificationLog", () => ({ logNotification: mocks.log }));
vi.mock("@/shared/dashboard/auditLog", () => ({ logBookingEvent: mocks.audit }));
vi.mock("@/shared/reminders/smsConsentSuppression", () => ({ recordInboundSmsConsent: mocks.consent }));
vi.mock("@/shared/noshow/promoteAndDeliverWaitlistOffer", () => ({ deliverCanonicalWaitlistPromotion: mocks.deliver }));
import { POST } from "./route";

const bookingId = "30260930-0000-4000-8000-000000000061";
const salonId = "30260930-0000-4000-8000-000000000031";
const applied = { ok: true, code: "applied", idempotent: false, booking_id: bookingId, salon_id: salonId };
function request(overrides: Record<string, string | undefined> = {}) {
  const params = { Body: "NO", AccountSid: `AC${"1".repeat(32)}`,
    MessageSid: `SM${"1".repeat(32)}`, From: "+16045550101", To: "+16045550999", ...overrides };
  return new NextRequest("https://nailiq.test/api/twilio/inbound", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(params).filter((entry): entry is [string,string] => typeof entry[1] === "string")),
  });
}
describe("atomic inbound cancellation adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NAILIQ_ATOMIC_INBOUND_SMS_CANCEL", "true");
    mocks.signature.mockReturnValue(true);
    mocks.rpc.mockResolvedValue({ data: applied, error: null });
    mocks.consent.mockResolvedValue({ ok: true });
    mocks.deliver.mockResolvedValue({ ok: true, code: "no_waiter" });
    mocks.from.mockImplementation(() => { throw new Error("legacy_selector_must_not_run"); });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("validates the signature before any booking command", async () => {
    mocks.signature.mockReturnValue(false);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("calls the atomic RPC with signed identity and body hash before mutable booking reads", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Your appointment is cancelled");
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("cancel_booking_from_signed_sms", {
      p_account_sid: `AC${"1".repeat(32)}`, p_message_sid: `SM${"1".repeat(32)}`,
      p_from_phone: "+16045550101", p_to_phone: "+16045550999",
      p_body_sha256: createHash("sha256").update("NO").digest("hex"),
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("acknowledges only the committed receipt on replay", async () => {
    mocks.rpc.mockResolvedValue({ data: { ...applied, idempotent: true }, error: null });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Your appointment is cancelled");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it("retains the legacy SmsMessageSid alias in the command", async () => {
    await POST(request({ MessageSid: undefined, SmsMessageSid: `SM${"3".repeat(32)}` }));
    expect(mocks.rpc.mock.calls[0][1].p_message_sid).toBe(`SM${"3".repeat(32)}`);
  });
  it("fails closed on a rejected network request without selecting another booking", async () => {
    mocks.rpc.mockRejectedValue(new Error("synthetic network failure"));
    expect((await POST(request())).status).toBe(503);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it.each(["ambiguous_salon", "not_found"])("does not claim cancellation for %s", async (code) => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, code, idempotent: false }, error: null });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("Your appointment is cancelled");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it.each([
    { data: null, error: { code: "42883" } },
    { data: { ok: false, code: "idempotency_mismatch" }, error: null },
    { data: { ok: false, code: "sender_unverified" }, error: null },
    { data: { ...applied, idempotent: undefined }, error: null },
    { data: { ...applied, booking_id: undefined }, error: null },
    { data: { ...applied, salon_id: "not-a-uuid" }, error: null },
    { data: { ...applied, code: "unexpected" }, error: null },
    { data: [applied], error: null },
  ])("fails closed without falling back on an unavailable or invalid RPC result: %j", async (result) => {
    mocks.rpc.mockResolvedValue(result);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("is cancelled");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it.each([false, true])("preserves exact promotion dispatch for idempotent=%s without fresh selection", async (idempotent) => {
    const promotion = { ok: true, code: "no_waiter" };
    mocks.rpc.mockResolvedValue({ data: { ...applied, idempotent, promoted_waitlist: promotion }, error: null });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.deliver).toHaveBeenCalledExactlyOnceWith(promotion);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it.each(["already_cancelled", "booking_changed"])("acknowledges the pinned %s receipt without dispatch or fresh selection", async (code) => {
    for (const idempotent of [false, true]) {
      mocks.rpc.mockResolvedValue({ data: { ...applied, code, idempotent, promoted_waitlist: { ok: true } }, error: null });
      const response = await POST(request());
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(code === "already_cancelled" ? "already cancelled" : "Nothing was cancelled by this reply");
    }
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it.each(["already_cancelled", "booking_changed"])("rejects %s without valid original identity", async (code) => {
    mocks.rpc.mockResolvedValue({ data: { ...applied, code, booking_id: null }, error: null });
    expect((await POST(request())).status).toBe(503);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it("does not hijack Advanced Opt-Out", async () => {
    expect((await POST(request({ Body: "STOP", OptOutType: "STOP" }))).status).toBe(200);
    expect(mocks.consent).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("keeps the carrier CANCEL keyword as opt-out, not appointment cancellation", async () => {
    expect((await POST(request({ Body: "CANCEL" }))).status).toBe(200);
    expect(mocks.consent).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([undefined, "false", "1", "TRUE"])("keeps the new path off unless explicitly true: %s", async (flag) => {
    vi.stubEnv("NAILIQ_ATOMIC_INBOUND_SMS_CANCEL", flag);
    const list = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), gte: vi.fn(), order: vi.fn(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }) };
    for (const method of ["select", "eq", "in", "gte", "order"] as const) list[method].mockReturnValue(list);
    mocks.from.mockReturnValue(list);
    expect((await POST(request())).status).toBe(200);
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith("bookings");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("ignores unknown commands", async () => {
    expect((await POST(request({ Body: "hello" }))).status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
