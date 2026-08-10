import { describe, expect, it } from "vitest";

import nextConfig from "../../../../next.config";

describe("camera permissions policy", () => {
  it("keeps camera blocked globally and allows it only on Nail Try-On", async () => {
    expect(nextConfig.headers).toBeTypeOf("function");
    const rules = await nextConfig.headers!();
    const globalRuleIndex = rules.findIndex((rule) => rule.source === "/((?!embed/).*)");
    const tryOnRuleIndex = rules.findIndex((rule) => rule.source === "/:slug/try-on");

    expect(globalRuleIndex).toBeGreaterThanOrEqual(0);
    expect(tryOnRuleIndex).toBeGreaterThan(globalRuleIndex);

    const globalPolicy = rules[globalRuleIndex]?.headers.find(
      (header) => header.key === "Permissions-Policy",
    );
    const tryOnPolicy = rules[tryOnRuleIndex]?.headers.find(
      (header) => header.key === "Permissions-Policy",
    );

    expect(globalPolicy?.value).toBe("camera=(), microphone=(self), geolocation=()");
    expect(tryOnPolicy?.value).toBe("camera=(self), microphone=(), geolocation=()");
  });
});
