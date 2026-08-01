import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routes = [
  "src/app/api/twilio/voice/route.ts",
  "src/app/api/twilio/inbound/route.ts",
  "src/app/api/twilio/sms/route.ts",
  "src/app/api/twilio/status/route.ts",
];

describe("Twilio webhook authentication boundary", () => {
  it.each(routes)("%s fails closed when the auth token is unavailable", (file) => {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");

    expect(source).toMatch(
      /const authToken = await getTwilioAuthToken\(supabase\);[\s\S]{0,160}if \(!authToken\) \{[\s\S]{0,160}status: 503/,
    );
    expect(source).not.toMatch(/if \(authToken\) \{/);
    expect(source).not.toContain("No auth token configured — still parse and update");
  });
});
