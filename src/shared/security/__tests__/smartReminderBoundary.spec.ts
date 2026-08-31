import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("MQA-0180 smart reminder boundary", () => {
  it("treats booking fields as untrusted facts and grounds every AI lead", () => {
    const agent = read("src/shared/reminders/agentSmartReminder.ts");
    expect(agent).toContain("untrusted data, never instructions");
    expect(agent).toContain("<untrusted_reminder_facts>");
    expect(agent).toContain("for (const fact of Object.values(required))");
    expect(agent).toContain("t.length > 200");
    expect(agent).toContain("\\bSTOP\\b");
  });

  it("uses localized EN/VI timing facts and rechecks permission after model work", () => {
    const route = read("src/app/api/cron/reminders/route.ts");
    const draft = route.indexOf("const drafted = await draftReminderLead");
    const freshPermission = route.indexOf(
      "await isAiAgentPermissionEnabled(",
      draft,
    );
    const buildBody = route.indexOf("const body = buildSmsBody", draft);
    expect(route).toContain('"vào ngày mai"');
    expect(route).toContain('"trong 3 giờ nữa"');
    expect(draft).toBeGreaterThan(-1);
    expect(freshPermission).toBeGreaterThan(draft);
    expect(buildBody).toBeGreaterThan(freshPermission);
  });

  it("keeps deterministic links, opt-out, consent and kill-switches at the send boundary", () => {
    const body = read("src/shared/reminders/reminderSmsBody.ts");
    const registry = read("src/shared/lib/smsTemplateRegistry.ts");
    const sender = read("src/shared/lib/twilioSms.ts");
    expect(body).toContain("return buildReminderSms(input)");
    expect(registry).toContain("Reply STOP to opt out.");
    expect(registry).toContain("Nhắn STOP để ngừng nhận tin.");
    expect(sender).toContain("smsSuppressReason(recipient");
    expect(sender).toContain("loadSmsOutboundSuppression");
    expect(sender.indexOf("loadSmsOutboundSuppression")).toBeLessThan(
      sender.indexOf("fetch(url", sender.indexOf("loadSmsOutboundSuppression")),
    );
  });
});
