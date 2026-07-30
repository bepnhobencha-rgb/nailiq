import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const controlCenter = readFileSync(
  resolve(process.cwd(), "src/components/dashboard/AiControlCenter.tsx"),
  "utf8",
);

describe("AI Control Center freshness boundary", () => {
  it("refreshes stale data through a full authenticated document request", () => {
    expect(controlCenter).toContain("window.location.reload()");
    expect(controlCenter).toContain("document.visibilityState");
    expect(controlCenter).not.toContain(
      'document.addEventListener("visibilitychange"',
    );
    expect(controlCenter).not.toMatch(/fetch\s*\(/);
  });

  it("cleans up the background refresh timer", () => {
    expect(controlCenter).toContain("window.clearInterval(intervalId)");
    expect(controlCenter).not.toContain(
      'document.removeEventListener("visibilitychange"',
    );
  });
});
