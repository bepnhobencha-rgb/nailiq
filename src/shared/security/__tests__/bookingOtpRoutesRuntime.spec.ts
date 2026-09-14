import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rate: vi.fn(), db: vi.fn(), sendSms: vi.fn(), sendEmail: vi.fn(), checkSms: vi.fn(), checkEmail: vi.fn(), claim: vi.fn(), complete: vi.fn(), verified: vi.fn(), demo: vi.fn(), insert: vi.fn(), update: vi.fn(), read: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.db }));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({ consumeDurableRateLimitBuckets: mocks.rate }));
vi.mock("@/shared/lib/twilioVerify", () => ({ sendVerification: mocks.sendSms, checkVerification: mocks.checkSms }));
vi.mock("@/shared/lib/emailOtp", () => ({ createAndSendEmailOtp: mocks.sendEmail, checkEmailOtp: mocks.checkEmail }));
vi.mock("@/shared/lib/demoOtpMode", () => ({ isDemoOtpRuntime: mocks.demo }));
vi.mock("@/shared/booking/otpDeliveryTruth", () => ({ createBookingOtpDeliveryAttempt: mocks.claim, completeBookingOtpDeliveryAttempt: mocks.complete, markBookingOtpDeliveryVerified: mocks.verified, isBookingOtpDeliveryAttemptId: (id: string) => /^[0-9a-f-]{36}$/.test(id) }));
import { POST as send } from "@/app/api/booking-otp/send/route";
import { POST as verify } from "@/app/api/booking-otp/verify/route";
import { POST as consume } from "@/app/api/booking-otp/consume-session/route";
const salonId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const valid = { phone: "+16045550199", shopSlug: "e2e-otp", code: "123456", email: "qa@example.test", deliveryAttemptId: attemptId, sessionId };
function request(value: unknown, length?: string) {
  return new Request("https://nailiq.test/api/booking-otp/test", { method: "POST", headers: { "content-type": "application/json", ...(length ? { "content-length": length } : {}) }, body: JSON.stringify(value) });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unit test network forbidden"); }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.rate.mockResolvedValue("allowed"); mocks.demo.mockReturnValue(false);
  mocks.read.mockResolvedValue({ data: { id: salonId, phone_otp_enabled: true, email_links_enabled: true }, error: null });
  mocks.insert.mockReturnValue({ select: () => ({ single: async () => ({ data: { id: sessionId }, error: null }) }) });
  const builder = { select: () => builder, eq: () => builder, is: async () => ({ error: null }), maybeSingle: mocks.read, insert: mocks.insert, update: mocks.update };
  mocks.update.mockReturnValue(builder); mocks.db.mockReturnValue({ from: () => builder });
  mocks.claim.mockResolvedValue({ ok: true, attemptId }); mocks.complete.mockResolvedValue(true); mocks.verified.mockResolvedValue(true);
  mocks.sendSms.mockResolvedValue({ ok: true, verificationSid: `VE${"a".repeat(32)}` });
  mocks.checkSms.mockResolvedValue({ ok: false, error: "invalid_code" }); mocks.checkEmail.mockResolvedValue({ ok: false, error: "invalid_code" });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function noProvider() { for (const fn of [mocks.sendSms, mocks.sendEmail, mocks.checkSms, mocks.checkEmail]) expect(fn).not.toHaveBeenCalled(); }
describe.each([["send", send], ["verify", verify], ["consume-session", consume]] as const)("OTP %s input boundary", (_name, handler) => {
  it.each([null, [], true, 42, "text"])("rejects non-object %j without DB/provider", async (value) => {
    expect((await handler(request(value))).status).toBe(400); expect(mocks.db).not.toHaveBeenCalled(); noProvider();
  });
  it("rejects a wrong field type without throwing", async () => {
    expect((await handler(request({ ...valid, phone: 123, code: {}, sessionId: [] }))).status).toBe(400); expect(mocks.db).not.toHaveBeenCalled(); noProvider();
  });
  it.each([undefined, "100"])("bounds actual stream with Content-Length %s", async (length) => {
    expect((await handler(request({ ...valid, padding: "x".repeat(4096) }, length))).status).toBe(400); expect(mocks.db).not.toHaveBeenCalled(); noProvider();
  });
});
describe.each([["send", send], ["verify", verify]] as const)("OTP %s durable quota", (_name, handler) => {
  it.each([["limited", 429, "900"], ["unavailable", 503, "30"]] as const)("blocks %s before body or providers", async (rate, status, retry) => {
    mocks.rate.mockResolvedValueOnce(rate);
    const response = await handler(request(valid)); expect(response.status).toBe(status); expect(response.headers.get("retry-after")).toBe(retry); expect(mocks.db).not.toHaveBeenCalled(); noProvider();
  });
  it("blocks an identity quota even if IP quota allows", async () => {
    mocks.rate.mockResolvedValueOnce("allowed").mockResolvedValueOnce("limited");
    expect((await handler(request(valid))).status).toBe(429); expect(mocks.db).not.toHaveBeenCalled(); noProvider();
  });
  it("blocks unknown or disabled salons before any provider", async () => {
    mocks.read.mockResolvedValue({ data: null, error: null });
    expect((await handler(request(valid))).status).toBe(400); noProvider();
  });
});
describe("OTP receipt and verification gates", () => {
  it("requires a durable claim before sending SMS", async () => {
    mocks.claim.mockResolvedValue({ ok: false, error: "delivery_unavailable" });
    expect((await send(request(valid))).status).toBe(503); noProvider();
  });
  it("reports suppressed SMS as unavailable, never sent", async () => {
    mocks.sendSms.mockResolvedValue({ ok: true, suppressed: true });
    const response = await send(request(valid)); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "sms_suppressed" });
    expect(mocks.complete).toHaveBeenCalledWith({ attemptId, status: "suppressed", errorCode: "sms_suppressed" });
  });
  it.each(["provider_response_unknown", "provider_response_unverified"])("preserves %s without automatic resend", async (error) => {
    mocks.sendSms.mockResolvedValue({ ok: false, error });
    const response = await send(request(valid)); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "delivery_unknown" });
    expect(mocks.sendSms).toHaveBeenCalledTimes(1); expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "unknown" }));
  });
  it("returns provider acceptance even if telemetry completion is pending, without resend", async () => {
    mocks.complete.mockResolvedValue(false);
    const response = await send(request(valid)); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ deliveryStatus: "provider_accepted" }); expect(mocks.sendSms).toHaveBeenCalledTimes(1);
  });
  it("honors disabled email channel", async () => {
    mocks.read.mockResolvedValue({ data: { id: salonId, phone_otp_enabled: true, email_links_enabled: false }, error: null });
    expect((await send(request({ ...valid, channel: "email" }))).status).toBe(400); noProvider();
  });
  it("does not mint a session after both channels reject", async () => {
    expect((await verify(request(valid))).status).toBe(400); expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("keeps a database verification failure unavailable without minting a session", async () => {
    mocks.checkEmail.mockResolvedValue({ ok: false, error: "server_error" });
    expect((await verify(request(valid))).status).toBe(503); expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("does not report consumption success after a database failure", async () => {
    const update = { eq: () => update, is: async () => ({ error: { code: "08006" } }) };
    mocks.update.mockReturnValue(update);
    const response = await consume(request(valid)); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "session_unavailable" });
  });
  it("mints a session only after accepted email verification and binds it to salon/phone", async () => {
    mocks.checkEmail.mockResolvedValue({ ok: true, deliveryAttemptId: attemptId });
    const response = await verify(request(valid)); expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, sessionId });
    expect(mocks.insert).toHaveBeenCalledWith({ phone: "16045550199", salon_id: salonId, verified_channel: "email" });
    expect(mocks.verified).toHaveBeenCalledWith({ salonId, channel: "email", recipient: valid.email, attemptId });
  });

  it.each(["never resolves", "throws"])("accepts valid email without contacting SMS that %s", async (failure) => {
    mocks.checkSms.mockImplementation(() => {
      if (failure === "throws") throw new Error("Synthetic SMS unavailable");
      return new Promise(() => undefined);
    });
    const emailAttemptId = "44444444-4444-4444-8444-444444444444";
    mocks.checkEmail.mockResolvedValue({ ok: true, deliveryAttemptId: emailAttemptId });
    const response = await verify(request({ ...valid, email: " QA@EXAMPLE.TEST " }));
    expect(response.status).toBe(200);
    expect(mocks.checkSms).not.toHaveBeenCalled();
    expect(mocks.checkEmail).toHaveBeenCalledExactlyOnceWith({ salonId, phone: "16045550199", email: "qa@example.test", code: valid.code });
    expect(mocks.insert).toHaveBeenCalledExactlyOnceWith({ phone: "16045550199", salon_id: salonId, verified_channel: "email" });
    expect(mocks.verified).toHaveBeenCalledExactlyOnceWith({ salonId, channel: "email", recipient: "qa@example.test", attemptId: emailAttemptId });
    expect(mocks.rate).toHaveBeenCalledTimes(2);
  });

  it.each(["invalid_code", "expired_or_max_attempts", "server_error"])("accepts SMS proof after email reports %s and records only SMS delivery", async (error) => {
    mocks.checkEmail.mockResolvedValue({ ok: false, error });
    mocks.checkSms.mockResolvedValue({ ok: true });
    const response = await verify(request(valid));
    expect(response.status).toBe(200);
    expect(mocks.checkEmail.mock.invocationCallOrder[0]).toBeLessThan(mocks.checkSms.mock.invocationCallOrder[0]);
    expect(mocks.checkSms).toHaveBeenCalledExactlyOnceWith(valid.phone, valid.code);
    expect(mocks.verified).toHaveBeenCalledExactlyOnceWith({ salonId, channel: "sms", recipient: valid.phone, attemptId });
    expect(mocks.insert).toHaveBeenCalledExactlyOnceWith({ phone: "16045550199", salon_id: salonId, verified_channel: "sms" });
  });

  it("uses the SMS path directly when no email was supplied", async () => {
    mocks.checkSms.mockResolvedValue({ ok: true });
    const response = await verify(request({ ...valid, email: undefined }));
    expect(response.status).toBe(200);
    expect(mocks.checkEmail).not.toHaveBeenCalled();
    expect(mocks.verified).toHaveBeenCalledExactlyOnceWith({ salonId, channel: "sms", recipient: valid.phone, attemptId });
  });

  it.each([false, true])("does not verify disabled email while preserving SMS approval=%s", async (smsApproved) => {
    mocks.read.mockResolvedValue({ data: { id: salonId, phone_otp_enabled: true, email_links_enabled: false }, error: null });
    mocks.checkEmail.mockResolvedValue({ ok: true, deliveryAttemptId: attemptId });
    mocks.checkSms.mockResolvedValue({ ok: smsApproved, error: smsApproved ? undefined : "invalid_code" });
    const response = await verify(request(valid));
    expect(response.status).toBe(smsApproved ? 200 : 400);
    expect(mocks.checkEmail).not.toHaveBeenCalled();
    if (smsApproved) expect(mocks.verified).toHaveBeenCalledExactlyOnceWith({ salonId, channel: "sms", recipient: valid.phone, attemptId });
    else {
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(mocks.verified).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["server_error", "invalid_code", 503, "server_error"],
    ["invalid_code", "server_error", 503, "server_error"],
    ["server_misconfigured", "expired_or_max_attempts", 503, "server_misconfigured"],
    ["expired_or_max_attempts", "server_misconfigured", 503, "server_misconfigured"],
    ["expired_or_max_attempts", "invalid_code", 410, "expired_or_max_attempts"],
    ["invalid_code", "expired_or_max_attempts", 400, "invalid_code"],
  ])("preserves failure truth for email=%s SMS=%s", async (emailError, smsError, status, expectedError) => {
    mocks.checkEmail.mockResolvedValue({ ok: false, error: emailError });
    mocks.checkSms.mockResolvedValue({ ok: false, error: smsError });
    const response = await verify(request(valid));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: expectedError });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.verified).not.toHaveBeenCalled();
  });

  it.each(["email", "sms"])("does not turn an unexpected %s verification exception into invalid code", async (channel) => {
    (channel === "email" ? mocks.checkEmail : mocks.checkSms).mockRejectedValue(new Error("Synthetic dependency unavailable"));
    const response = await verify(request(valid));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "server_error" });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.verified).not.toHaveBeenCalled();
  });
});
