import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  createClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";

const FORGED_SLUG = "hilite-forged-target";
const TEST_PROJECT_URL = "https://abcdefghijklmnopqrst.supabase.co";
const PRODUCTION_PROJECT_URL =
  "https://fshmobzyjhmtvndobwsy.supabase.co";

function stubEnvironment(overrides: Record<string, string> = {}): void {
  const baseline: Record<string, string> = {
    NODE_ENV: "development",
    CI: "",
    GITHUB_ACTIONS: "",
    VERCEL: "",
    VERCEL_ENV: "",
    DEMO_OTP: "true",
    NEXT_PUBLIC_DEMO_OTP: "true",
    NAILIQ_TEST_BYPASS_SLUG_PIN: "1",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    E2E_EXPECTED_PROJECT_REF: "",
    NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
    BASE_URL: "http://localhost:3000",
    PLAYWRIGHT_BASE_URL: "http://localhost:3000",
  };

  for (const [name, value] of Object.entries({ ...baseline, ...overrides })) {
    vi.stubEnv(name, value);
  }
}

function installAnonymousForgedCookie(slug = FORGED_SLUG): void {
  mocks.createClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
    },
  });
  mocks.cookies.mockResolvedValue({
    get: vi.fn((name: string) =>
      name === "nailiq-demo-slug" ? { value: slug } : undefined,
    ),
  });
}

function installDemoSalonLookup(): void {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: {
      id: "salon-e2e",
      name: "E2E Salon",
      slug: FORGED_SLUG,
      phone: "+15555550100",
      email: null,
      address: "100 Test Street",
      salon_phone: null,
      opening_hours: null,
      profile_complete: true,
      booking_closed_dates: null,
      closure_notice: null,
      timezone: "America/Vancouver",
      dashboard_modules: null,
      dashboard_preset: null,
      dashboard_density: null,
      currency_code: "CAD",
    },
    error: null,
  });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  mocks.createServiceRoleClient.mockReturnValue({
    from: vi.fn().mockReturnValue({ select }),
  });
}

describe("demo slug-pin service-role boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAnonymousForgedCookie();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a forged tenant cookie in a production runtime before service-role creation", async () => {
    stubEnvironment({
      NODE_ENV: "production",
      CI: "true",
      VERCEL_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: TEST_PROJECT_URL,
    });

    await expect(resolveSalonForDashboard(FORGED_SLUG)).resolves.toBeNull();
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("rejects a forged tenant cookie against the production project before service-role creation", async () => {
    stubEnvironment({
      NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_PROJECT_URL,
    });

    await expect(resolveSalonForDashboard(FORGED_SLUG)).resolves.toBeNull();
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("rejects the pinned demo-salon cookie in production even when DEMO_OTP=true and bypass=false", async () => {
    installAnonymousForgedCookie("demo-salon");
    stubEnvironment({
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      DEMO_OTP: "true",
      NEXT_PUBLIC_DEMO_OTP: "true",
      NAILIQ_TEST_BYPASS_SLUG_PIN: "0",
      NEXT_PUBLIC_SUPABASE_URL: TEST_PROJECT_URL,
    });

    await expect(resolveSalonForDashboard("demo-salon")).resolves.toBeNull();
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("rejects the pinned demo-salon cookie against the production project", async () => {
    installAnonymousForgedCookie("demo-salon");
    stubEnvironment({
      DEMO_OTP: "true",
      NEXT_PUBLIC_DEMO_OTP: "true",
      NAILIQ_TEST_BYPASS_SLUG_PIN: "0",
      NEXT_PUBLIC_SUPABASE_URL: PRODUCTION_PROJECT_URL,
      E2E_EXPECTED_PROJECT_REF: "fshmobzyjhmtvndobwsy",
    });

    await expect(resolveSalonForDashboard("demo-salon")).resolves.toBeNull();
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("rejects a forged tenant cookie on preview when the remote project is not explicitly pinned", async () => {
    stubEnvironment({
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
      NEXT_PUBLIC_SUPABASE_URL: TEST_PROJECT_URL,
      NEXT_PUBLIC_SITE_URL: "https://nailiq-git-qa.example.vercel.app",
    });

    await expect(resolveSalonForDashboard(FORGED_SLUG)).resolves.toBeNull();
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("preserves a local E2E fixture cookie against a throwaway project", async () => {
    stubEnvironment();
    installDemoSalonLookup();

    await expect(resolveSalonForDashboard(FORGED_SLUG)).resolves.toMatchObject({
      kind: "demo_cookie",
      role: "owner",
      salon: { id: "salon-e2e", slug: FORGED_SLUG },
    });
    expect(mocks.createServiceRoleClient).toHaveBeenCalledTimes(1);
  });

  it("preserves the GitHub CI next-start fixture against its loopback project", async () => {
    stubEnvironment({
      NODE_ENV: "production",
      CI: "true",
      GITHUB_ACTIONS: "true",
    });
    installDemoSalonLookup();

    await expect(resolveSalonForDashboard(FORGED_SLUG)).resolves.toMatchObject({
      kind: "demo_cookie",
      salon: { id: "salon-e2e", slug: FORGED_SLUG },
    });
    expect(mocks.createServiceRoleClient).toHaveBeenCalledTimes(1);
  });

  it("rejects a revoked member session before any tenant membership read", async () => {
    stubEnvironment({
      DEMO_OTP: "false",
      NEXT_PUBLIC_DEMO_OTP: "false",
      NAILIQ_TEST_BYPASS_SLUG_PIN: "0",
    });
    const from = vi.fn();
    mocks.createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "revoked-member" } },
          error: null,
        }),
      },
      rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
      from,
    });

    await expect(resolveSalonForDashboard(FORGED_SLUG)).resolves.toBeNull();
    expect(from).not.toHaveBeenCalled();
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
  });
});
