import { describe, expect, it } from "vitest";

import type { DemoOtpEnvironment } from "@/shared/lib/demoOtpMode";
import { isTurnIqRushHourDemoAllowed } from "@/shared/turniq/rushHourDemoBoundary";

const QA_REF = "abcdefghijklmnopqrst";

function previewEnv(overrides: Partial<DemoOtpEnvironment> = {}): DemoOtpEnvironment {
  return {
    NODE_ENV: "production",
    VERCEL: "1",
    VERCEL_ENV: "preview",
    DEMO_OTP: "true",
    NAILIQ_TEST_BYPASS_SLUG_PIN: "1",
    NEXT_PUBLIC_SUPABASE_URL: `https://${QA_REF}.supabase.co`,
    E2E_EXPECTED_PROJECT_REF: QA_REF,
    ...overrides,
  };
}

describe("TurnIQ rush-hour demo boundary", () => {
  it("allows a Vercel Preview without requiring branch-specific QA secrets", () => {
    expect(isTurnIqRushHourDemoAllowed("preview.example.vercel.app", {
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "preview",
    }))
      .toBe(true);
  });

  it("allows local development backed by loopback Supabase", () => {
    expect(isTurnIqRushHourDemoAllowed("127.0.0.1:3000", {
      NODE_ENV: "development",
      DEMO_OTP: "true",
      NAILIQ_TEST_BYPASS_SLUG_PIN: "1",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    })).toBe(true);
  });

  it("fails closed for production even when demo flags are copied", () => {
    expect(isTurnIqRushHourDemoAllowed("nailiq.ca", previewEnv({
      VERCEL_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: "https://fshmobzyjhmtvndobwsy.supabase.co",
      E2E_EXPECTED_PROJECT_REF: "fshmobzyjhmtvndobwsy",
    }))).toBe(false);
  });

  it("fails closed for a production hostname even if Preview is claimed", () => {
    expect(isTurnIqRushHourDemoAllowed("nailiq.vercel.app", previewEnv()))
      .toBe(false);
  });

  it("does not expose the route on an arbitrary non-Preview host", () => {
    expect(isTurnIqRushHourDemoAllowed("staging.example.com", previewEnv({
      VERCEL_ENV: "development",
    }))).toBe(false);
  });
});
