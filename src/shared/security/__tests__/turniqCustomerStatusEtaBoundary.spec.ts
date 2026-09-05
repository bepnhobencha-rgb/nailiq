import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function source(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

const loader = source("src/shared/turniq/customerStatusEtaLoader.ts");
const route = source("src/app/api/booking/status/route.ts");
const page = source("src/app/booking/status/page.tsx");

describe("TurnIQ M4K customer status ETA security boundary", () => {
  it("validates the capability before loading TurnIQ truth", () => {
    expect(route.indexOf("inspectBookingManagementCapability")).toBeLessThan(
      route.indexOf("loadTurnIqCustomerStatusEta({"),
    );
    expect(route).toContain("const { booking, context } = inspected.inspection");
    expect(route).toContain("booking: inspected.inspection.booking");
    expect(route).toContain("turnIqEta,");
  });

  it("checks the default-off feature before group or assignment ledger reads", () => {
    expect(loader.indexOf("featureVisible(salon")).toBeLessThan(
      loader.indexOf("repository.loadConfirmedGroupPlan"),
    );
    expect(loader.indexOf("featureVisible(salon")).toBeLessThan(
      loader.indexOf("repository.loadActiveAssignment"),
    );
    expect(loader).toContain('"turniq_trust_engine"');
  });

  it("scopes every authoritative ledger query to the validated salon", () => {
    const tenantFilters = loader.match(/\.eq\("salon_id", salonId\)/g) ?? [];
    expect(tenantFilters.length).toBeGreaterThanOrEqual(3);
    expect(loader).toContain('.eq("booking_id", bookingId)');
    expect(loader).toContain('.eq("booking_group_id", groupId)');
    expect(loader).toContain('.eq("group_plan_id", planId)');
  });

  it("keeps the customer surface provider-free and non-mutating", () => {
    expect(loader).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/);
    expect(loader).not.toMatch(/stripe|square|twilio|resend/i);
    expect(page).not.toMatch(/staffId|revenue|tip|queuePosition|snapshotVersion/i);
    expect(page).toContain("Showing the last confirmed appointment status");
    expect(page).toContain("You are on the walk-in list. The salon will assign your time.");
  });
});
