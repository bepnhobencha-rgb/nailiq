import { beforeEach, describe, expect, it, vi } from "vitest";

const { readAuthPlatformFlags } = vi.hoisted(() => ({
  readAuthPlatformFlags: vi.fn(),
}));
vi.mock("@/app/login/LoginPageClient", () => ({ LoginPageClient: () => null }));
vi.mock("@/shared/lib/demoOtpMode", () => ({ isDemoOtpRuntime: () => false }));
vi.mock("@/shared/register/platformFlagReader", () => ({ readAuthPlatformFlags }));

import LoginPage from "./page";

describe("login callback feedback allowlist", () => {
  beforeEach(() => {
    readAuthPlatformFlags.mockResolvedValue({ smsEnabled: false, emailEnabled: true });
  });

  it("passes only an allowlisted fee destination into login", async () => {
    const next = "/dashboard/test-salon/cancellation-fee/4378c3c6-f485-4ab4-9cb2-2011e82f5d66";
    const valid = await LoginPage({ searchParams: Promise.resolve({ next }) });
    expect(valid.props.returnTo).toBe(next);
    const invalid = await LoginPage({ searchParams: Promise.resolve({ next: "//evil.example" }) });
    expect(invalid.props.returnTo).toBeNull();
  });

  it.each([
    ["link_session_expired", "link_session_expired"],
    ["pkce_restart", "pkce_restart"],
    ["session", "session"],
    ["flow_state_expired", null],
    ["private@example.test <script>alert(1)</script>", null],
    [undefined, null],
  ])("accepts only safe feedback for %s", async (error, expected) => {
    const element = await LoginPage({ searchParams: Promise.resolve({ error }) });
    expect(element.props.authError).toBe(expected);
    expect(element.props.showConfirmEmailNotice).toBe(false);
    expect(element.props.showPasswordResetNotice).toBe(false);
  });
});
