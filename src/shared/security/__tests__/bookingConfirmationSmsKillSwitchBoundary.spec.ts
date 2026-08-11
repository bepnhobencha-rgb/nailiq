import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const route = readFileSync(
  resolve(process.cwd(), "src/app/api/booking/sms-confirm/route.ts"),
  "utf8",
);

describe("booking confirmation SMS kill-switch boundary", () => {
  it("loads the salon SMS switch before attempting a confirmation send", () => {
    expect(route).toContain("sms_outbound_enabled");
    expect(route).toMatch(
      /const result = smsOutboundEnabled\s*\? await sendSmsReminder/,
    );
  });

  it("does not stamp, log, or fan out SMS when the switch is disabled", () => {
    expect(route).toMatch(
      /if \(smsOutboundEnabled\) \{\s*const \{ error: trackError \}/,
    );
    expect(route).toMatch(
      /if \(smsOutboundEnabled\) \{\s*void logNotification/,
    );
    expect(route).toContain("if (smsOutboundEnabled && isGroup && groupId)");
  });
});
