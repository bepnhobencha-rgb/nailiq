import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Square card-capture failure UX boundary", () => {
  it("surfaces an external Chrome escape hatch for Android WebViews", () => {
    const fallback = read("src/components/booking/CardWebviewFallback.tsx");
    const detector = read("src/shared/lib/inAppBrowser.ts");

    expect(detector).toContain("Version\\/4\\.0");
    expect(detector).toContain("\\bwv\\b");
    expect(fallback).toContain("package=com.android.chrome");
    expect(fallback).toContain('data-testid="card-webview-open-chrome"');
  });

  it("does not add a second generic error when the child already reported tokenization failure", () => {
    const individual = read("src/components/booking/BookingFlowConfirmPanel.tsx");
    const group = read("src/components/booking/BookingGroupFlow.tsx");

    expect(individual).not.toMatch(
      /if \(!result\) \{\s*setCardError\(/,
    );
    expect(group).not.toMatch(
      /if \(!result\) \{\s*setErrorMessage\(t\.noShowCardError/,
    );
  });
});
