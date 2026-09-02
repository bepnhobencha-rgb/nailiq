import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(process.cwd(), "src/shared/turniq/customerEta.ts"),
  "utf8",
);

describe("TurnIQ M4J customer ETA boundary", () => {
  it("stays pure and provider independent", () => {
    expect(source).not.toMatch(
      /from\s+["'][^"']*(supabase|stripe|square|twilio|resend)|fetch\(|createClient\(/i,
    );
    expect(source).toContain("projectTurnIqCustomerEta");
    expect(source).toContain("measureTurnIqCustomerEtaAccuracy");
  });

  it("does not accept customer, booking, technician or financial fields", () => {
    expect(source).not.toMatch(
      /\b(customerName|customerPhone|customerEmail|bookingId|staffId|revenueCents|tipCents|fairnessCreditCents|queuePosition)\s*:/,
    );
  });
});
