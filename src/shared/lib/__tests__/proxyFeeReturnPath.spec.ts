import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), getUser: vi.fn(), from: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.auth }));
vi.mock("@/shared/lib/customDomainResolver", () => ({ isPlatformHost: () => true, resolveCustomDomainSlug: vi.fn() }));
vi.mock("@/shared/lib/rateLimit", () => ({ checkAuthRateLimit: () => false, checkBookingPageRateLimit: () => false, checkBookingRateLimit: () => false }));
vi.mock("@/shared/lib/demoOtpMode", () => ({ isDemoOtpRuntime: () => false, isDemoSlugPinBypassed: () => false, DEMO_SALON_SLUG: "demo-salon" }));
vi.mock("@/shared/observability/errorReporter", () => ({ getCurrentScope: () => ({ setTag: vi.fn() }) }));
import { proxy } from "@/proxy";

const target = "/dashboard/test-salon/cancellation-fee/4378c3c6-f485-4ab4-9cb2-2011e82f5d66";

describe("fee email shortcut proxy auth boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    mocks.auth.mockReturnValue({ auth: { getUser: mocks.getUser }, from: mocks.from });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("redirects an anonymous email reader to sign-in with the exact safe destination", async () => {
    const response = await proxy(new NextRequest(`https://www.nailiq.ca${target}`));
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(target);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("does not preserve action-like queries or general dashboard paths", async () => {
    const feeResponse = await proxy(new NextRequest(`https://www.nailiq.ca${target}?charge=true`));
    const location = new URL(feeResponse.headers.get("location")!);
    expect(location.searchParams.get("next")).toBe(target);
    expect(location.toString()).not.toContain("charge");
    const generic = await proxy(new NextRequest("https://www.nailiq.ca/dashboard/test-salon/settings"));
    expect(generic.headers.get("location")).toBe("https://www.nailiq.ca/login");
  });

  it("keeps email confirmation required and preserves the fee destination", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user", email: "owner@example.test" } }, error: null });
    const response = await proxy(new NextRequest(`https://www.nailiq.ca${target}`));
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("notice")).toBe("confirm-email");
    expect(location.searchParams.get("next")).toBe(target);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("resumes the fee page for signed-in members without substituting their first salon", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user", email: "owner@example.test", email_confirmed_at: "2026-09-26" } }, error: null });
    mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { salon_id: "other-salon" } }) }) }) }) });
    const response = await proxy(new NextRequest(`https://www.nailiq.ca/login?next=${encodeURIComponent(target)}`));
    expect(response.headers.get("location")).toBe(`https://www.nailiq.ca${target}`);
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith("salon_members");
  });
});
