import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn(), suppression: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({ rpc: m.rpc }) }));
vi.mock("./customerEmailDeliverySuppression", () => ({ customerEmailDeliverySuppressionReason: m.suppression, customerEmailRecipientFingerprint: () => "a".repeat(64) }));
import { claimCardRetryEmail, completeCardRetryEmail } from "./cardRetryEmailReceipt";
const input = { salonId: "salon", bookingId: "booking", actorId: "actor", email: "qa@example.invalid" };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DISABLE_OUTBOUND_EMAIL", "0"); vi.stubEnv("DEMO_OTP", "false"); vi.stubEnv("NEXT_PUBLIC_DEMO_OTP", "false");
  m.suppression.mockResolvedValue(null);
  m.rpc.mockResolvedValue({ data: { state: "claimed", id: "receipt", attempt_id: "attempt" }, error: null });
});
afterEach(() => vi.unstubAllEnvs());
it("claims once with a fingerprint, not an email in the ledger", async () => {
  expect(await claimCardRetryEmail(input)).toEqual({ id: "receipt", attemptId: "attempt", salonId: "salon" });
  expect(JSON.stringify(m.rpc.mock.calls)).not.toContain(input.email);
});
it.each(["claimed_bad", "blocked", "already_accepted", "forbidden"])("does not send on %s", async state => {
  m.rpc.mockResolvedValue({ data: { state }, error: null });
  expect(await claimCardRetryEmail(input)).toBeNull();
});
it.each(["bounced", "lookup_unavailable"])("fails closed for %s", async reason => {
  m.suppression.mockResolvedValue(reason);
  expect(await claimCardRetryEmail(input)).toBeNull(); expect(m.rpc).not.toHaveBeenCalled();
});
it.each(["DISABLE_OUTBOUND_EMAIL", "DEMO_OTP", "NEXT_PUBLIC_DEMO_OTP"])("honors %s before touching database", async key => {
  vi.stubEnv(key, key === "DISABLE_OUTBOUND_EMAIL" ? "1" : "true");
  expect(await claimCardRetryEmail(input)).toBeNull(); expect(m.rpc).not.toHaveBeenCalled();
});
it("blocks local runtime and absent actors", async () => {
  expect(await claimCardRetryEmail({ ...input, actorId: null })).toBeNull();
  vi.stubEnv("NODE_ENV", "development"); expect(await claimCardRetryEmail(input)).toBeNull();
  expect(m.rpc).not.toHaveBeenCalled();
});
it.each(["true", "yes", " TRUE "])("honors the email kill switch value %s", async value => {
  vi.stubEnv("DISABLE_OUTBOUND_EMAIL", value);
  expect(await claimCardRetryEmail(input)).toBeNull(); expect(m.rpc).not.toHaveBeenCalled();
});
it("fails closed on a lost claim response", async () => {
  m.rpc.mockRejectedValue(new Error("transport")); expect(await claimCardRetryEmail(input)).toBeNull();
});
it("requires an acknowledged completion and fences the attempt", async () => {
  const lease = { id: "receipt", attemptId: "attempt", salonId: "salon" };
  m.rpc.mockResolvedValue({ data: true, error: null });
  expect(await completeCardRetryEmail(lease, "provider-id")).toBe(true);
  expect(m.rpc).toHaveBeenCalledWith("complete_card_retry_email", { p_salon_id: "salon", p_receipt_id: "receipt", p_attempt_id: "attempt", p_provider_message_id: "provider-id" });
  m.rpc.mockRejectedValue(new Error("lost response")); expect(await completeCardRetryEmail(lease, null)).toBe(false);
});
