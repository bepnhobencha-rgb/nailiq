import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/app/api/cron/reminders/route.ts"),
  "utf8",
);

describe("reminder worker failure boundary", () => {
  it("turns rejected reminder tasks into an honest failed cron response", () => {
    expect(source).toContain(
      "const taskResults = await Promise.allSettled",
    );
    expect(source).toContain("const taskFailures = taskResults.filter");
    expect(source).toContain('error: "processing_failed"');
    expect(source).toContain("{ status: 500 }");
    expect(source).toContain(
      'console.error("[reminders] processing failures", { taskFailures })',
    );
  });

  it("fails visibly when relationship or sent-marker writes fail", () => {
    expect(source).toContain('throw new Error("group_members_query_failed")');
    expect(source).toContain('throw new Error("group_reminder_marker_failed")');
    expect(source).toContain('throw new Error("reminder_marker_failed")');
  });
});
