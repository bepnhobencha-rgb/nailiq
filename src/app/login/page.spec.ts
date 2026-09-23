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
