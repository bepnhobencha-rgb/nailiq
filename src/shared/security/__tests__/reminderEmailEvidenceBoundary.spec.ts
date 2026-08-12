import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cronSource = fs.readFileSync(
  path.join(process.cwd(), "src/app/api/cron/reminders/route.ts"),
  "utf8",
);
const emailSource = fs.readFileSync(
  path.join(process.cwd(), "src/shared/noshow/sendReminderEmail.ts"),
  "utf8",
);

describe("reminder email delivery evidence", () => {
  it("returns the Resend provider message id", () => {
    expect(emailSource).toContain("messageId?: string");
    expect(emailSource).toContain("messageId: data?.id");
  });

  it("logs individual, group organizer, and group member email outcomes", () => {
    expect(cronSource.match(/messageSid: result\.messageId \?\? null/g)).toHaveLength(2);
    expect(cronSource).toContain("messageSid: memberResult.messageId ?? null");
    expect(cronSource).toContain('channel: "email"');
  });
});
