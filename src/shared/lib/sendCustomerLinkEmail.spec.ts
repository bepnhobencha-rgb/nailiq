import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ send: vi.fn(), suppressed: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/resend", () => ({ getResendClient: () => ({ emails: { send: m.send } }), getResendFrom: () => "test@example.invalid" }));
vi.mock("@/shared/lib/emailCompliance", () => ({ isEmailSuppressed: m.suppressed }));
vi.mock("@/shared/lib/emailExperience", () => ({ buildEmailExperience: () => ({ html: "synthetic", text: "synthetic", headers: {}, tags: [] }) }));
import { sendCustomerLinkEmail } from "./sendCustomerLinkEmail";
const input = { email: "guest@example.invalid", salonName: "Synthetic", subject: "Synthetic", bodyText: "Synthetic", ctaLabel: "Open", url: "https://example.invalid", requireReceipt: true };
beforeEach(() => { vi.resetAllMocks(); });
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
