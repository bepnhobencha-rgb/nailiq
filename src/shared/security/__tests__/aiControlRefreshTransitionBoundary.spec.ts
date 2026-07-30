import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const controlCenter = readFileSync(
  resolve(
    process.cwd(),
    "src/components/dashboard/AiControlCenter.tsx",
  ),
  "utf8",
);

describe("AI Control Center refresh transition boundary", () => {
  it("schedules background App Router refreshes inside a React transition", () => {
    expect(controlCenter).toContain("startTransition(() => {");
    expect(controlCenter).toMatch(
      /startTransition\(\(\) => \{\s*router\.refresh\(\);\s*\}\);/,
    );
    expect(controlCenter).not.toMatch(
      /shouldRefreshAiControlCenter\([\s\S]*?\)\s*\{\s*router\.refresh\(\);/,
    );
  });
});
