import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/shared/ai/operatingState.ts"),
  "utf8",
);

describe("AI operating-state boundary", () => {
  it("scopes every queue count to the requested salon", () => {
    expect(source).toContain('.eq("salon_id" as never, salonId)');
    expect(source).toContain('.eq("status" as never, status)');
  });

  it("filters global and cross-salon lessons from owner-facing controls", () => {
    expect(source).toContain("if (lesson.salonId !== salonId) continue");
  });

  it("is read-only and adds no execution or messaging authority", () => {
    expect(source).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(source).not.toMatch(/sendSms|sendEmail|enqueueApprovedAction/);
  });
});
