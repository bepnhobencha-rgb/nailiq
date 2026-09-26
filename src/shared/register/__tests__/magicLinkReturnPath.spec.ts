import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ signInWithOtp: vi.fn(), rate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/shared/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signInWithOtp: mocks.signInWithOtp } }) }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/shared/lib/twilioVerify", () => ({ sendVerification: vi.fn(), checkVerification: vi.fn() }));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({ consumePublicServerActionRateLimit: mocks.rate }));
import { sendEmailMagicLink } from "../actions";
const target = "/dashboard/test-salon/cancellation-fee/4378c3c6-f485-4ab4-9cb2-2011e82f5d66";

describe("magic-link fee destination boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.nailiq.ca");
    mocks.rate.mockResolvedValue("allowed");
    mocks.signInWithOtp.mockResolvedValue({ error: null });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("preserves only the validated destination in the provider callback", async () => {
    await expect(sendEmailMagicLink("owner@example.test", target)).resolves.toEqual({ success: true, mode: "email_link" });
    const redirect = new URL(mocks.signInWithOtp.mock.calls[0][0].options.emailRedirectTo);
    expect(redirect.origin).toBe("https://www.nailiq.ca");
    expect(redirect.pathname).toBe("/auth/callback");
    expect(redirect.searchParams.get("next")).toBe(target);
  });
  it.each(["https://evil.example", "//evil.example", `${target}?charge=true`, undefined])("ignores arbitrary caller-controlled navigation %s", async (next) => {
    await sendEmailMagicLink("owner@example.test", next);
    expect(mocks.signInWithOtp.mock.calls[0][0].options.emailRedirectTo).toBe("https://www.nailiq.ca/auth/callback");
  });
  it("does not bypass the existing auth-email rate limit", async () => {
    mocks.rate.mockResolvedValue("limited");
    await expect(sendEmailMagicLink("owner@example.test", target)).resolves.toMatchObject({ success: false });
    expect(mocks.signInWithOtp).not.toHaveBeenCalled();
  });
});
