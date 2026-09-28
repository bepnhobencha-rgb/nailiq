import { describe, expect, it } from "vitest";
import { isPinnedCardRetryQaEmail } from "./resendQaBoundary";

const bookingId = "00000000-0000-4000-8000-000000000001";
const recipient = "qa@example.invalid";
const qa = {
  NAILIQ_QA_CARD_RETRY_EMAIL_ENABLED: "1",
  NAILIQ_QA_CARD_RETRY_EMAIL_BOOKING_ID: bookingId,
  DISABLE_OUTBOUND_EMAIL: "1",
  NAILIQ_RESEND_QA_WEBHOOK_ONLY: "1",
  NAILIQ_DISPOSABLE_DB: "1",
  NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF: "uhpzafoiifupyypkcwln",
  NEXT_PUBLIC_SUPABASE_URL: "https://uhpzafoiifupyypkcwln.supabase.co",
  SUPABASE_INTERNAL_URL: "https://uhpzafoiifupyypkcwln.supabase.co",
  NAILIQ_QA_RESEND_EMAIL_RECIPIENT: recipient,
  VERCEL_ENV: "preview",
};

describe("pinned card-retry email QA rehearsal", () => {
  it("allows the exact booking and recipient only on disposable Preview with the global switch still off", () => {
    expect(isPinnedCardRetryQaEmail({ bookingId, recipient }, qa)).toBe(true);
  });

  it.each([
    ["rehearsal disabled", { NAILIQ_QA_CARD_RETRY_EMAIL_ENABLED: "0" }],
    ["email globally enabled", { DISABLE_OUTBOUND_EMAIL: "0" }],
    ["different booking", { NAILIQ_QA_CARD_RETRY_EMAIL_BOOKING_ID: "00000000-0000-4000-8000-000000000002" }],
    ["invalid booking pin", { NAILIQ_QA_CARD_RETRY_EMAIL_BOOKING_ID: "booking" }],
    ["production environment", { VERCEL_ENV: "production" }],
    ["production database", { NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF: "fshmobzyjhmtvndobwsy" }],
    ["wrong database URL", { SUPABASE_INTERNAL_URL: "https://fshmobzyjhmtvndobwsy.supabase.co" }],
    ["non-disposable database", { NAILIQ_DISPOSABLE_DB: "0" }],
  ])("rejects %s", (_name, override) => {
    expect(isPinnedCardRetryQaEmail({ bookingId, recipient }, { ...qa, ...override })).toBe(false);
  });

  it("rejects other recipients and booking IDs", () => {
    expect(isPinnedCardRetryQaEmail({ bookingId, recipient: "other@example.invalid" }, qa)).toBe(false);
    expect(isPinnedCardRetryQaEmail({ bookingId: "00000000-0000-4000-8000-000000000002", recipient }, qa)).toBe(false);
  });
});
