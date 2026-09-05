import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  create: vi.fn(),
  signIn: vi.fn(),
  signUp: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumePublicServerActionRateLimit: mocks.rate,
}));
vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.create,
}));

import { authenticateWithEmailPassword } from "../emailPasswordAuth";

describe("email/password auth server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rate.mockResolvedValue("allowed");
    mocks.create.mockResolvedValue({
      auth: { signInWithPassword: mocks.signIn, signUp: mocks.signUp },
    });
    mocks.signIn.mockResolvedValue({ data: { user: { id: "user" } }, error: null });
    mocks.signUp.mockResolvedValue({ data: { session: null }, error: null });
  });

  it.each([
    ["limited", "rate_limited"],
    ["unavailable", "server_error"],
  ] as const)("makes zero auth-provider calls when limiter is %s", async (rate, error) => {
    mocks.rate.mockResolvedValue(rate);
    await expect(
      authenticateWithEmailPassword("owner@example.com", "Password1", "signin"),
    ).resolves.toEqual({ ok: false, error });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("authenticates only after the hashed server limiter allows", async () => {
    await expect(
      authenticateWithEmailPassword(" OWNER@example.com ", "Password1", "signin"),
    ).resolves.toEqual({ ok: true, status: "signed_in" });
    expect(mocks.rate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "auth-password-signin",
        identity: "owner@example.com",
      }),
    );
    expect(mocks.signIn).toHaveBeenCalledWith({
      email: "owner@example.com",
      password: "Password1",
    });
  });

  it.each([
    [
      { code: "email_address_invalid", message: "Email address is invalid" },
      "email_address_unusable",
    ],
    [
      {
        code: "email_address_not_authorized",
        message: "Email address is not authorized",
      },
      "confirmation_email_unavailable",
    ],
    [
      {
        code: "unexpected_failure",
        message: "Error sending confirmation email",
      },
      "confirmation_email_unavailable",
    ],
    [
      {
        code: "over_email_send_rate_limit",
        message: "Email rate limit exceeded",
      },
      "rate_limited",
    ],
    [
      { code: "user_already_exists", message: "User already registered" },
      "account_exists",
    ],
    [{ code: "unexpected_failure", message: "Database unavailable" }, "server_error"],
    [
      { code: "unexpected_failure", message: "Too many database connections" },
      "server_error",
    ],
  ] as const)(
    "returns actionable signup truth for provider error %#",
    async (providerError, expectedError) => {
      mocks.signUp.mockResolvedValue({ data: { session: null }, error: providerError });

      await expect(
        authenticateWithEmailPassword(
          "new-owner@example.com",
          "Password1",
          "signup",
        ),
      ).resolves.toEqual({ ok: false, error: expectedError });
    },
  );

  it("returns confirmation_required only when the provider accepted signup", async () => {
    await expect(
      authenticateWithEmailPassword(
        "new-owner@example.com",
        "Password1",
        "signup",
      ),
    ).resolves.toEqual({ ok: true, status: "confirmation_required" });
  });
});
