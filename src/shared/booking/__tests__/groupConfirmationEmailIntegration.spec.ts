import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("group confirmation email rollout boundary", () => {
  it("uses the shared authoritative producer and removes the desk lead-only receipt", () => {
    const sideEffects = read("../groupBookingSideEffects.ts");
    const submit = read("../submitGroupBooking.ts");
    const receptionist = read("../../dashboard/receptionistActions.ts");
    const groupCreate = receptionist.slice(
      receptionist.indexOf("export async function createDeskGroup"),
      receptionist.indexOf("export async function cancelDeskGroup"),
    );
    expect(sideEffects).toContain("sendGroupBookingConfirmationEmail(args.authoritativeConfirmation)");
    expect(submit).toContain("authoritativeConfirmation: authoritativePricing && bookingIdList[0]");
    expect(groupCreate).not.toContain("/api/booking-email");
    expect(receptionist).toContain("authoritativeConfirmation: {");
  });

  it("keeps controlled after-hours explicitly snapshot-gated", () => {
    const submit = read("../submitGroupBooking.ts");
    expect(submit).toContain("let authoritativePricing: GroupBookingPricingQuote | null = null");
    expect(submit).toContain("authoritativeConfirmation: authoritativePricing && bookingIdList[0]");
    expect(submit).not.toMatch(/controlledAfterHoursExecution[\s\S]{0,600}authoritativePricing\s*=/);
  });
});
