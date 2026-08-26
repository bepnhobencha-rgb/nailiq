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

  it("caps and durably persists terminal status callbacks before acknowledging them", () => {
    const status = fs.readFileSync(
      path.join(process.cwd(), "src/app/api/twilio/status/route.ts"),
      "utf8",
    );
    const notificationLog = fs.readFileSync(
      path.join(process.cwd(), "src/shared/lib/notificationLog.ts"),
      "utf8",
    );
    const receiptMigration = fs.readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/20260823124500_record_twilio_status_receipts_atomically.sql",
      ),
      "utf8",
    );

    expect(status).toContain("readUrlEncodedFormWithLimit(req, 8_192)");
    expect(status.indexOf("readUrlEncodedFormWithLimit(req, 8_192)")).toBeLessThan(
      status.indexOf('import("@/shared/lib/supabase/serviceRole")'),
    );
    expect(status).toContain("MESSAGE_SID_RE");
    expect(status).toContain("TERMINAL_STATUSES.has(messageStatus)");
    expect(status).toMatch(
      /if \(!updated\.ok\)[\s\S]+return new NextResponse\("Service unavailable", \{ status: 503 \}\)/,
    );
    expect(notificationLog).toContain("record_twilio_message_status_receipt");
    expect(receiptMigration).toContain("twilio_message_status_receipts");
    expect(receiptMigration).toContain("pg_advisory_xact_lock");
    expect(receiptMigration).toContain("exact_replay");
    expect(receiptMigration).toContain("durable_conflict");
    expect(receiptMigration).toContain("delivery_fingerprint");
  });
});
