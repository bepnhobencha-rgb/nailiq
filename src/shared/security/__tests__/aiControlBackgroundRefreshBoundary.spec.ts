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

describe("AI Control Center background refresh boundary", () => {
  it("keeps lifecycle refreshes out of the App Router action queue", () => {
    expect(controlCenter).toContain("window.location.reload();");
    expect(controlCenter).not.toMatch(
      /shouldRefreshAiControlCenter\([\s\S]*?\)\s*\{\s*router\.refresh\(\);/,
    );
    expect(controlCenter).not.toContain(
      'document.addEventListener("visibilitychange", refreshIfStale)',
    );
  });
});
