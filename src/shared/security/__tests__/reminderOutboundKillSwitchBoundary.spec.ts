import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(process.cwd(), "src/app/api/cron/reminders/route.ts"),
  "utf8",
);

describe("reminder outbound kill switches", () => {
  it("loads both tenant channel switches", () => {
    expect(source).toContain("sms_outbound_enabled");
    expect(source).toContain("email_outbound_enabled");
  });

  it("blocks individual and group delivery when explicitly disabled", () => {
    expect(source).toContain("salon.email_outbound_enabled === false");
    expect(source).toContain("salon.email_outbound_enabled !== false && !!booking.client_email");
    expect(source).toContain("salon.sms_outbound_enabled !== false && salon.sms_reminders_enabled");
  });
});
