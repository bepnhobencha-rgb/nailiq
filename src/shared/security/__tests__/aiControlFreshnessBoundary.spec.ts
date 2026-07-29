import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const controlCenter = readFileSync(
  resolve(process.cwd(), "src/components/dashboard/AiControlCenter.tsx"),
  "utf8",
);

describe("AI Control Center freshness boundary", () => {
  it("refreshes only through the authenticated server-rendered route", () => {
    expect(controlCenter).toContain("router.refresh()");
    expect(controlCenter).toContain("document.visibilityState");
    expect(controlCenter).toContain(
      'document.addEventListener("visibilitychange", refreshIfStale)',
    );
    expect(controlCenter).not.toMatch(/fetch\s*\(/);
  });

  it("cleans up both timer and visibility listener", () => {
    expect(controlCenter).toContain("window.clearInterval(intervalId)");
    expect(controlCenter).toContain(
      'document.removeEventListener("visibilitychange", refreshIfStale)',
    );
  });
});
