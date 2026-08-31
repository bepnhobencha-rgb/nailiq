import { describe, expect, it } from "vitest";

import {
  decideSmartCheckoutReconciliation,
  fingerprintSmartCheckoutProviderAccount,
  reconciliationReceiptFromProvider,
  type SmartCheckoutReconciliationClaim,
  type SmartCheckoutReconciliationReceipt,
} from "@/shared/checkout/smartCheckoutReconciliation";

const claim: SmartCheckoutReconciliationClaim = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  salonId: "22222222-2222-4222-8222-222222222222",
  provider: "stripe",
  providerAccountFingerprint: "a".repeat(64),
  providerLocationId: "tml_qa",
  providerDeviceId: "tmr_qa",
  providerCheckoutId: "pi_qa",
  amountCents: 5_350,
  currency: "USD",
  attemptToken: "33333333-3333-4333-8333-333333333333",
};

const receipt: SmartCheckoutReconciliationReceipt = {
  provider: "stripe",
  providerAccountFingerprint: "a".repeat(64),
  providerLocationId: "tml_qa",
  providerDeviceId: "tmr_qa",
  checkoutId: "pi_qa",
  paymentId: "pi_qa",
  providerStatus: "succeeded",
  status: "paid",
  amountCents: 5_350,
  currency: "usd",
  occurredAt: "2026-08-31T17:00:00Z",
};

describe("Smart Checkout reconciliation truth", () => {
  it("derives the durable provider account fingerprint from adapter evidence", () => {
    const fingerprint = fingerprintSmartCheckoutProviderAccount("stripe", "acct_qa");
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(reconciliationReceiptFromProvider({
      provider: "stripe",
      checkoutId: "pi_qa",
      paymentId: "ch_qa",
      providerStatus: "succeeded",
      status: "paid",
      evidence: {
        amountCents: 5_350,
        currency: "USD",
        providerAccountId: "acct_qa",
        providerLocationId: "tml_qa",
        providerDeviceId: "tmr_qa",
        occurredAt: "2026-08-31T17:00:00Z",
      },
    })).toMatchObject({
      providerAccountFingerprint: fingerprint,
      checkoutId: "pi_qa",
      amountCents: 5_350,
    });
  });

  it("accepts a paid receipt only when account, checkout, device, location, amount and currency match", () => {
    expect(decideSmartCheckoutReconciliation(claim, receipt)).toEqual({
      ok: true,
      disposition: "resolved",
      status: "paid",
      receipt,
    });
  });

  it.each([
    [{ providerAccountFingerprint: "b".repeat(64) }, "provider_context_mismatch"],
    [{ checkoutId: "pi_other" }, "provider_checkout_mismatch"],
    [{ providerLocationId: "tml_other" }, "provider_location_mismatch"],
    [{ providerDeviceId: "tmr_other" }, "provider_device_mismatch"],
    [{ amountCents: 5_349 }, "receipt_amount_mismatch"],
    [{ currency: "CAD" }, "receipt_currency_mismatch"],
    [{ paymentId: null }, "paid_receipt_incomplete"],
  ] as const)("fails closed to manual review for mismatched receipt material", (override, code) => {
    expect(decideSmartCheckoutReconciliation(claim, { ...receipt, ...override })).toEqual({
      ok: false,
      disposition: "manual_review",
      code,
    });
  });

  it("schedules another provider read for a non-terminal receipt without calling it paid", () => {
    expect(decideSmartCheckoutReconciliation(claim, {
      ...receipt,
      status: "pending_provider",
      providerStatus: "requires_capture",
      paymentId: null,
      amountCents: null,
      currency: null,
    })).toMatchObject({ ok: true, disposition: "retry", status: "pending_provider" });
  });
});
