import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  rate: vi.fn(),
  resetEmail: vi.fn(),
  active: vi.fn(),
  getSession: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  membership: vi.fn(),
  getRole: vi.fn(),
  clearRole: vi.fn(),
  cookieGet: vi.fn(),
  cookieDelete: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: mocks.cookieGet,
    delete: mocks.cookieDelete,
  })),
}));
vi.mock("@/shared/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumePublicServerActionRateLimit: mocks.rate,
}));
vi.mock("@/shared/auth/requireActiveAuthSession", () => ({
  requireActiveAuthSession: mocks.active,
}));
vi.mock("@/shared/lib/superadmin", () => ({
  getSuperAdminRole: mocks.getRole,
  clearSuperAdminCache: mocks.clearRole,
}));

import {
  completeSalonOwnerPasswordReset,
  requestSalonOwnerPasswordReset,
} from "../salonOwnerAuth";
import {
  completeSuperadminPasswordReset,
  requestSuperadminPasswordReset,
} from "@/shared/superadmin/superadminAuth";
import {
  issuePasswordRecoveryCapability,
  verifyPasswordRecoveryIntent,
} from "../passwordRecoverySecurity";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const accessToken = `e30.${Buffer.from(
  JSON.stringify({ session_id: SESSION_ID }),
).toString("base64url")}.sig`;

describe("password reset server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example");
    vi.stubEnv("PASSWORD_RECOVERY_SIGNING_SECRET", "r".repeat(64));
    mocks.rate.mockResolvedValue("allowed");
    mocks.resetEmail.mockResolvedValue({ error: null });
    mocks.active.mockResolvedValue({ ok: true, user: { id: USER_ID } });
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: accessToken } },
      error: null,
    });
    mocks.updateUser.mockResolvedValue({ error: null });
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.membership.mockResolvedValue({ data: { id: "member" }, error: null });
    mocks.getRole.mockResolvedValue("founder");

    const membershipBuilder = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: mocks.membership,
    };
    mocks.createClient.mockResolvedValue({
      auth: {
        resetPasswordForEmail: mocks.resetEmail,
        getSession: mocks.getSession,
        updateUser: mocks.updateUser,
        signOut: mocks.signOut,
      },
      rpc: vi.fn(),
      from: vi.fn(() => membershipBuilder),
    });
  });

  it("keeps malformed, limited, and unknown reset requests anti-enumerating", async () => {
    await expect(requestSalonOwnerPasswordReset("not-an-email")).resolves.toEqual({
      ok: true,
    });
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.resetEmail).not.toHaveBeenCalled();

    mocks.rate.mockResolvedValueOnce("limited");
    await expect(
      requestSalonOwnerPasswordReset("owner@example.com"),
    ).resolves.toEqual({ ok: true });
    expect(mocks.resetEmail).not.toHaveBeenCalled();

    mocks.rate.mockResolvedValue("allowed");
    await expect(
      requestSalonOwnerPasswordReset(" OWNER@example.com "),
    ).resolves.toEqual({ ok: true });
    const salonRedirect = new URL(
      mocks.resetEmail.mock.calls.at(-1)?.[1]?.redirectTo as string,
    );
    expect(salonRedirect.origin + salonRedirect.pathname).toBe(
      "https://app.example/auth/recovery",
    );
    expect(salonRedirect.searchParams.get("surface")).toBe("salon");
    expect(
      verifyPasswordRecoveryIntent({
        token: salonRedirect.searchParams.get("state"),
        surface: "salon",
        email: "owner@example.com",
      }),
    ).toBe(true);
  });

  it("fails closed on limiter outage before Auth email dispatch", async () => {
    mocks.rate.mockResolvedValue("unavailable");
    await expect(
      requestSuperadminPasswordReset("admin@example.com"),
    ).resolves.toEqual({ ok: false, error: "server_error" });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.resetEmail).not.toHaveBeenCalled();
  });

  it("uses the fixed SuperAdmin recovery redirect without privileged email lookup", async () => {
    await expect(
      requestSuperadminPasswordReset(" ADMIN@example.com "),
    ).resolves.toEqual({ ok: true });
    const adminRedirect = new URL(
      mocks.resetEmail.mock.calls.at(-1)?.[1]?.redirectTo as string,
    );
    expect(adminRedirect.searchParams.get("surface")).toBe("superadmin");
    expect(
      verifyPasswordRecoveryIntent({
        token: adminRedirect.searchParams.get("state"),
        surface: "superadmin",
        email: "admin@example.com",
      }),
    ).toBe(true);
  });

  it("blocks an ordinary active session that lacks the recovery capability", async () => {
    mocks.cookieGet.mockReturnValue(undefined);
    await expect(
      completeSalonOwnerPasswordReset("Password1"),
    ).resolves.toEqual({ ok: false, error: "no_session" });
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("blocks revoked sessions before membership or password mutation", async () => {
    mocks.active.mockResolvedValue({ ok: false, code: "session_revoked" });
    await expect(
      completeSalonOwnerPasswordReset("Password1"),
    ).resolves.toEqual({ ok: false, error: "no_session" });
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("distinguishes Auth outage from an invalid or revoked recovery session", async () => {
    mocks.active.mockResolvedValue({ ok: false, code: "auth_unavailable" });
    await expect(
      completeSalonOwnerPasswordReset("Password1"),
    ).resolves.toEqual({ ok: false, error: "server_error" });
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("updates once, clears the bearer, globally signs out, and rejects replay", async () => {
    let token: string | undefined = issuePasswordRecoveryCapability({
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    mocks.cookieGet.mockImplementation(() =>
      token ? { value: token } : undefined,
    );
    mocks.cookieDelete.mockImplementation(() => {
      token = undefined;
    });

    await expect(
      completeSalonOwnerPasswordReset("Password1"),
    ).resolves.toEqual({ ok: true });
    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "global" });

    await expect(
      completeSalonOwnerPasswordReset("Password1"),
    ).resolves.toEqual({ ok: false, error: "no_session" });
    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
  });

  it("fails closed on membership read errors and on revoked SuperAdmin role", async () => {
    const token = issuePasswordRecoveryCapability({
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    mocks.cookieGet.mockReturnValue({ value: token });
    mocks.membership.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(
      completeSalonOwnerPasswordReset("Password1"),
    ).resolves.toEqual({ ok: false, error: "server_error" });
    expect(mocks.updateUser).not.toHaveBeenCalled();

    mocks.getRole.mockResolvedValue(null);
    await expect(
      completeSuperadminPasswordReset("Password1"),
    ).resolves.toEqual({ ok: false, error: "no_role" });
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "global" });
  });

  it("rejects oversized passwords before any session or provider access", async () => {
    await expect(
      completeSuperadminPasswordReset("x".repeat(73)),
    ).resolves.toEqual({ ok: false, error: "weak_password" });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});
