import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ send: vi.fn(), suppressed: vi.fn(), qaBoundary: vi.fn(), qaTags: vi.fn(), pinnedCardRetry: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/resend", () => ({ getResendClient: () => ({ emails: { send: m.send } }), getResendFrom: () => "test@example.invalid" }));
vi.mock("@/shared/lib/emailCompliance", () => ({ isEmailSuppressed: m.suppressed }));
vi.mock("@/shared/lib/emailExperience", () => ({ buildEmailExperience: () => ({ html: "synthetic", text: "synthetic", headers: {}, tags: [] }) }));
vi.mock("@/shared/notifications/resendQaBoundary", () => ({ resolveResendQaBoundary: m.qaBoundary, resendQaTagsForRecipient: m.qaTags, isPinnedCardRetryQaEmail: m.pinnedCardRetry }));
import { sendCustomerLinkEmail } from "./sendCustomerLinkEmail";
const input = { email: "guest@example.invalid", salonName: "Synthetic", subject: "Synthetic", bodyText: "Synthetic", ctaLabel: "Open", url: "https://example.invalid", requireReceipt: true };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("DISABLE_OUTBOUND_EMAIL", "0");
  m.qaBoundary.mockReturnValue({ mode: "normal" }); m.qaTags.mockReturnValue([]);
});
afterEach(() => vi.unstubAllEnvs());
it.each(["1", "true", "yes", " TRUE "])("does not call Resend when outbound email is disabled with %s", async value => {
  vi.stubEnv("DISABLE_OUTBOUND_EMAIL", value);
  expect(await sendCustomerLinkEmail(input)).toEqual({ ok: false, error: "email_suppressed" });
  expect(m.send).not.toHaveBeenCalled();
});
it("allows only the pinned one-shot card retry through the shared email kill switch", async () => {
  vi.stubEnv("DISABLE_OUTBOUND_EMAIL", "1");
  const qaInput = { ...input, qaCardRetryBookingId: "00000000-0000-4000-8000-000000000001", idempotencyKey: "card-retry-email/receipt" };
  m.pinnedCardRetry.mockReturnValue(true);
  m.send.mockResolvedValue({ data: { id: "synthetic-receipt" }, error: null });
  expect(await sendCustomerLinkEmail(qaInput)).toEqual({ ok: true, providerMessageId: "synthetic-receipt" });
  expect(m.pinnedCardRetry).toHaveBeenCalledWith({ bookingId: qaInput.qaCardRetryBookingId, recipient: input.email });
  m.send.mockClear();
  for (const unscoped of [
    { ...qaInput, requireReceipt: false },
    { ...qaInput, idempotencyKey: "other/receipt" },
    { ...qaInput, qaCardRetryBookingId: undefined },
  ]) expect(await sendCustomerLinkEmail(unscoped)).toEqual({ ok: false, error: "email_suppressed" });
  expect(m.send).not.toHaveBeenCalled();
});
it("fails closed before Resend when the QA recipient is not pinned", async () => {
  m.qaTags.mockReturnValue(null);
  expect(await sendCustomerLinkEmail(input)).toEqual({ ok: false, error: "qa_recipient_unverified" });
  expect(m.qaTags).toHaveBeenCalledWith(input.email, { mode: "normal" });
  expect(m.send).not.toHaveBeenCalled();
});
it("attaches QA tags to the provider request for a pinned recipient", async () => {
  m.qaBoundary.mockReturnValue({ mode: "qa", projectRef: "abcdefghijklmnopqrst", recipient: input.email });
  m.qaTags.mockReturnValue([{ name: "nailiq_env", value: "qa" }]);
  m.send.mockResolvedValue({ data: { id: "synthetic-receipt" }, error: null });
  expect(await sendCustomerLinkEmail(input)).toEqual({ ok: true, providerMessageId: "synthetic-receipt" });
  expect(m.send).toHaveBeenCalledWith(expect.objectContaining({ tags: [{ name: "nailiq_env", value: "qa" }] }), undefined);
});
it("requires a provider message ID for strict success", async () => {
  m.send.mockResolvedValue({ data: { id: "synthetic-receipt" }, error: null });
  expect(await sendCustomerLinkEmail({ ...input, idempotencyKey: "synthetic-key" })).toEqual({ ok: true, providerMessageId: "synthetic-receipt" });
  expect(m.send).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: "synthetic-key" });
});
it("missing receipt is not accepted", async () => {
  m.send.mockResolvedValue({ data: null, error: null });
  expect(await sendCustomerLinkEmail(input)).toEqual({ ok: false, error: "missing_receipt" });
});
it("suppression is not sending", async () => {
  m.suppressed.mockResolvedValue(true);
  expect(await sendCustomerLinkEmail({ ...input, respectOptOut: true })).toEqual({ ok: false, error: "suppressed" });
  expect(m.send).not.toHaveBeenCalled();
});
it("preserves legacy optional receipt behavior", async () => {
  m.send.mockResolvedValue({ data: null, error: null });
  expect(await sendCustomerLinkEmail({ ...input, requireReceipt: false })).toEqual({ ok: true });
});
