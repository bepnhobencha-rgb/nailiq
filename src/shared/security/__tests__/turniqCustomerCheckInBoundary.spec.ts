import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return fs.readFileSync(path.join(process.cwd(), relative), "utf8");
}

const contract = read("src/shared/turniq/customerCheckIn.ts");
const observation = read("src/shared/turniq/customerEtaObservation.ts");
const page = read("src/app/e2e-local/turniq-customer-checkin/page.tsx");
const harness = read(
  "src/app/e2e-local/turniq-customer-checkin/TurnIqCustomerCheckInHarness.tsx",
);
const managerPage = read("src/app/e2e-local/turniq-checkin-manager/page.tsx");
const managerHarness = read(
  "src/app/e2e-local/turniq-checkin-manager/TurnIqCheckInManagerHarness.tsx",
);

describe("TurnIQ M4L customer check-in boundary", () => {
  it("keeps public intake pure, PII-free and non-mutating", () => {
    expect(contract).not.toMatch(
      /supabase|serviceRole|fetch\(|\.insert\(|\.update\(|\.delete\(|\.rpc\(|stripe|square|twilio|resend/i,
    );
    expect(contract).not.toMatch(
      /\b(customerName|customerPhone|customerEmail|priceCents|revenueCents|tipCents|queuePosition|waitMinutes)\s*:/,
    );
    expect(contract).toContain("shadowOnly: true");
    expect(contract).toContain("WALKIN_IDENTITY_MATCH_REQUIRED");
    expect(contract).toContain('source: "customer_selected"');
  });

  it("keeps ETA observations free of tenant, booking, customer and staff IDs", () => {
    expect(observation).not.toMatch(
      /\b(salonId|bookingId|customerId|staffId|resourceId|revenueCents|tipCents)\s*:/,
    );
    expect(observation).not.toMatch(/supabase|fetch\(|stripe|square|twilio|resend/i);
    expect(observation).toContain("measureTurnIqCustomerEtaAccuracy");
  });

  it("makes the browser story loopback-and-test-flag only", () => {
    expect(page).toContain("!isDemoSlugPinBypassed()");
    expect(page).toContain("LOOPBACK_HOST_RE.test(host)");
    expect(page).toContain("notFound()");
    expect(harness).toContain("no database, booking or provider calls");
    expect(harness).toContain('scenario === "offline"');
    expect(managerPage).toContain("!isDemoSlugPinBypassed()");
    expect(managerPage).toContain("LOOPBACK_HOST_RE.test(host)");
    expect(managerPage).toContain("notFound()");
    expect(managerHarness).not.toMatch(
      /supabase|stripe|square|twilio|resend|createPayment|sendSms|sendEmail/i,
    );
  });
});
