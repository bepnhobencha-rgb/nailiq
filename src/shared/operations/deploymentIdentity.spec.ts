import { describe, expect, it } from "vitest";

import { deploymentIdentity } from "./deploymentIdentity";

describe("deploymentIdentity", () => {
  it("prefers the exact Git commit used by Vercel", () => {
    expect(deploymentIdentity({
      VERCEL_GIT_COMMIT_SHA: "abc123",
      VERCEL_DEPLOYMENT_ID: "dpl_fallback",
      npm_package_version: "1.2.3",
    })).toBe("abc123");
  });

  it("uses stable fallbacks without accepting blank values", () => {
    expect(deploymentIdentity({
      VERCEL_GIT_COMMIT_SHA: "  ",
      VERCEL_DEPLOYMENT_ID: "dpl_123",
      npm_package_version: "1.2.3",
    })).toBe("dpl_123");

    expect(deploymentIdentity({ npm_package_version: "1.2.3" })).toBe("1.2.3");
    expect(deploymentIdentity({})).toBe("dev");
  });
});
