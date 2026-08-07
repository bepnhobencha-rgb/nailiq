import { describe, expect, it } from "vitest";

import { isInAppBrowser } from "@/shared/lib/inAppBrowser";

describe("isInAppBrowser", () => {
  it.each([
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Version/4.0 Chrome/120.0 Mobile Safari/537.36; wv)",
    "Mozilla/5.0 (Linux; Android 9) AppleWebKit/537.36 Version/4.0 Chrome/74.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Instagram 434.0.0.0",
    "Mozilla/5.0 FBAN/FBIOS;FBAV/500.0",
  ])("detects payment-hostile embedded browser: %s", (ua) => {
    expect(isInAppBrowser(ua)).toBe(true);
  });

  it.each([
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0 Safari/537.36",
  ])("does not flag a normal browser: %s", (ua) => {
    expect(isInAppBrowser(ua)).toBe(false);
  });
});
