import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isDemoOtpRuntime,
  isDemoSlugPinBypassed,
  type DemoOtpEnvironment,
} from "@/shared/lib/demoOtpMode";

const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";
const TEST_PROJECT_URL = "https://abcdefghijklmnopqrst.supabase.co";
const PRODUCTION_PROJECT_URL =
  "https://fshmobzyjhmtvndobwsy.supabase.co";

const BASE_ENV: DemoOtpEnvironment = {
  NODE_ENV: "development",
  DEMO_OTP: "true",
  NAILIQ_TEST_BYPASS_SLUG_PIN: "1",
  NEXT_PUBLIC_SUPABASE_URL: LOCAL_SUPABASE_URL,
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
};

describe("isDemoOtpRuntime", () => {
  it("honors explicit demo flags on a positively identified local test target", () => {
    expect(
      isDemoOtpRuntime({
        ...BASE_ENV,
        NODE_ENV: "production",
        CI: "true",
        GITHUB_ACTIONS: "true",
        NEXT_PUBLIC_DEMO_OTP: "true",
      }),
    ).toBe(true);
    expect(
      isDemoOtpRuntime({ ...BASE_ENV, DEMO_OTP: "false" }),
    ).toBe(false);
  });

  it("forces DEMO_OTP=true off in a production runtime", () => {
    expect(
      isDemoOtpRuntime({
        ...BASE_ENV,
        NODE_ENV: "production",
        VERCEL_ENV: "production",
        DEMO_OTP: "true",
      }),
    ).toBe(false);
  });

  it("forces DEMO_OTP=true off against the production project", () => {
    expect(
      isDemoOtpRuntime({
        ...BASE_ENV,
        DEMO_OTP: "true",
        NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_PROJECT_URL,
        E2E_EXPECTED_PROJECT_REF: "fshmobzyjhmtvndobwsy",
      }),
    ).toBe(false);
  });

  it("forces demo off for an unpinned remote preview project", () => {
    expect(
      isDemoOtpRuntime({
        ...BASE_ENV,
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        DEMO_OTP: "true",
        NEXT_PUBLIC_SUPABASE_URL: TEST_PROJECT_URL,
      }),
    ).toBe(false);
  });
});

describe("isDemoSlugPinBypassed", () => {
  it.each<{
    name: string;
    env: DemoOtpEnvironment;
    expected: boolean;
  }>([
    {
      name: "local E2E with a throwaway Supabase stack",
      env: BASE_ENV,
      expected: true,
    },
    {
      name: "CI next-start build with a throwaway Supabase stack",
      env: {
        ...BASE_ENV,
        NODE_ENV: "production",
        CI: "true",
        GITHUB_ACTIONS: "true",
      },
      expected: true,
    },
    {
      name: "preview runtime with a dedicated test project",
      env: {
        ...BASE_ENV,
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        NEXT_PUBLIC_SUPABASE_URL: TEST_PROJECT_URL,
        E2E_EXPECTED_PROJECT_REF: "abcdefghijklmnopqrst",
        NEXT_PUBLIC_SITE_URL: "https://nailiq-git-qa.example.vercel.app",
      },
      expected: true,
    },
    {
      name: "preview runtime with an unpinned remote project",
      env: {
        ...BASE_ENV,
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        NEXT_PUBLIC_SUPABASE_URL: TEST_PROJECT_URL,
        NEXT_PUBLIC_SITE_URL: "https://nailiq-git-qa.example.vercel.app",
      },
      expected: false,
    },
    {
      name: "preview runtime with a mismatched remote-project pin",
      env: {
        ...BASE_ENV,
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        NEXT_PUBLIC_SUPABASE_URL: TEST_PROJECT_URL,
        E2E_EXPECTED_PROJECT_REF: "zzzzzzzzzzzzzzzzzzzz",
        NEXT_PUBLIC_SITE_URL: "https://nailiq-git-qa.example.vercel.app",
      },
      expected: false,
    },
    {
      name: "missing bypass flag",
      env: { ...BASE_ENV, NAILIQ_TEST_BYPASS_SLUG_PIN: undefined },
      expected: false,
    },
    {
      name: "disabled demo runtime",
      env: { ...BASE_ENV, DEMO_OTP: "false" },
      expected: false,
    },
    {
      name: "generic CI marker without GitHub runner identity",
      env: {
        ...BASE_ENV,
        NODE_ENV: "production",
        CI: "true",
      },
      expected: false,
    },
    {
      name: "Vercel production runtime even with a test project",
      env: {
        ...BASE_ENV,
        NODE_ENV: "production",
        CI: "TRUE",
        VERCEL_ENV: '"production"',
        NEXT_PUBLIC_SUPABASE_URL: TEST_PROJECT_URL,
      },
      expected: false,
    },
    {
      name: "production Supabase project in development",
      env: {
        ...BASE_ENV,
        NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_PROJECT_URL,
        E2E_EXPECTED_PROJECT_REF: "fshmobzyjhmtvndobwsy",
      },
      expected: false,
    },
    {
      name: "production Supabase project in CI",
      env: {
        ...BASE_ENV,
        NODE_ENV: "production",
        CI: "true",
        GITHUB_ACTIONS: "true",
        NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_PROJECT_URL,
      },
      expected: false,
    },
    {
      name: "production application hostname",
      env: {
        ...BASE_ENV,
        CI: "true",
        NEXT_PUBLIC_SITE_URL: "https://www.nailiq.ca",
      },
      expected: false,
    },
    {
      name: "self-hosted production runtime outside CI",
      env: {
        ...BASE_ENV,
        NODE_ENV: "production",
        CI: undefined,
      },
      expected: false,
    },
    {
      name: "missing Supabase target",
      env: { ...BASE_ENV, NEXT_PUBLIC_SUPABASE_URL: undefined },
      expected: false,
    },
    {
      name: "unrecognisable Supabase target",
      env: {
        ...BASE_ENV,
        NEXT_PUBLIC_SUPABASE_URL: "https://database.example.test",
      },
      expected: false,
    },
  ])("returns $expected for $name", ({ env, expected }) => {
    expect(isDemoSlugPinBypassed(env)).toBe(expected);
  });
});

describe("demo-cookie authorization callers", () => {
  it.each([
    "src/proxy.ts",
    "src/shared/dashboard/salonOwnerActions.ts",
    "src/shared/dashboard/setupActions.ts",
  ])("routes %s through the production-aware bypass guard", (relativePath) => {
    const source = readFileSync(join(process.cwd(), relativePath), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    expect(code).toContain("isDemoSlugPinBypassed()");
    expect(code).not.toContain(
      "process.env.NAILIQ_TEST_BYPASS_SLUG_PIN",
    );
  });
});
