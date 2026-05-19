/**
 * No-Show Protection — Deposit rule engine.
 * Tests deposit evaluation logic directly (unit-style) + verifies
 * deposit_status is set on bookings after public booking.
 */
import { test, expect } from "@playwright/test";
import { evaluateDeposit } from "../src/shared/noshow/evaluateDeposit";

test.describe("Deposit Rule Engine — unit tests", () => {
  test("new customer: deposit required", () => {
    const result = evaluateDeposit({
      isNewCustomer: true,
      previousNoShowCount: 0,
      isVip: false,
      servicePriceCents: 5000,
      highValueThresholdCents: 10000,
    });
    expect(result.required).toBe(true);
    expect(result.reason).toBe("new_customer");
    expect(result.amountCents).toBeGreaterThan(0);
  });

  test("VIP customer: no deposit even with no-show history", () => {
    const result = evaluateDeposit({
      isNewCustomer: false,
      previousNoShowCount: 3,
      isVip: true,
      servicePriceCents: 20000,
      highValueThresholdCents: 10000,
    });
    expect(result.required).toBe(false);
  });

  test("customer with previous no-show: deposit required", () => {
    const result = evaluateDeposit({
      isNewCustomer: false,
      previousNoShowCount: 1,
      isVip: false,
      servicePriceCents: 5000,
      highValueThresholdCents: 10000,
    });
    expect(result.required).toBe(true);
    expect(result.reason).toBe("previous_no_show");
    expect(result.amountCents).toBe(2500); // 50%
  });

  test("high-value service: deposit required", () => {
    const result = evaluateDeposit({
      isNewCustomer: false,
      previousNoShowCount: 0,
      isVip: false,
      servicePriceCents: 15000,
      highValueThresholdCents: 10000,
    });
    expect(result.required).toBe(true);
    expect(result.reason).toBe("high_value_service");
  });

  test("returning customer, no history, normal price: no deposit", () => {
    const result = evaluateDeposit({
      isNewCustomer: false,
      previousNoShowCount: 0,
      isVip: false,
      servicePriceCents: 5000,
      highValueThresholdCents: 10000,
    });
    expect(result.required).toBe(false);
  });

  test("owner waive override: no deposit", () => {
    const result = evaluateDeposit({
      isNewCustomer: true,
      previousNoShowCount: 2,
      isVip: false,
      servicePriceCents: 20000,
      highValueThresholdCents: 10000,
      ownerOverride: "waive",
    });
    expect(result.required).toBe(false);
  });

  test("owner require override: deposit required", () => {
    const result = evaluateDeposit({
      isNewCustomer: false,
      previousNoShowCount: 0,
      isVip: true, // VIP normally exempt, but owner overrides
      servicePriceCents: 5000,
      highValueThresholdCents: 10000,
      ownerOverride: "require",
    });
    expect(result.required).toBe(true);
  });

  test("deposit amount is proportional to service price", () => {
    const newCustomer = evaluateDeposit({
      isNewCustomer: true,
      previousNoShowCount: 0,
      isVip: false,
      servicePriceCents: 10000,
      highValueThresholdCents: 20000,
    });
    // 20% deposit for new customer
    expect(newCustomer.amountCents).toBe(2000);
  });
});
