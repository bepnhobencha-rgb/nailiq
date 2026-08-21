import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ active: vi.fn(), cookieGet: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: mocks.cookieGet })),
}));
vi.mock("../requireActiveAuthSession", () => ({
  requireActiveAuthSession: mocks.active,
}));

import { requireActivePasswordRecoverySession } from "../requireActivePasswordRecoverySession";
import { issuePasswordRecoveryCapability } from "../passwordRecoverySecurity";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const accessToken = `e30.${Buffer.from(
  JSON.stringify({ session_id: SESSION_ID }),
).toString("base64url")}.sig`;

describe("active password recovery session boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PASSWORD_RECOVERY_SIGNING_SECRET", "q".repeat(64));
    mocks.active.mockResolvedValue({ ok: true, user: { id: USER_ID } });
  });

  it("requires both current active Auth state and the exact session-bound cookie", async () => {
    mocks.cookieGet.mockReturnValue({
      value: issuePasswordRecoveryCapability({
        userId: USER_ID,
        sessionId: SESSION_ID,
      }),
    });
    const client = {
      auth: {
        getUser: vi.fn(),
        getSession: vi.fn(async () => ({
          data: { session: { access_token: accessToken } },
          error: null,
        })),
      },
      rpc: vi.fn(),
    };
    await expect(requireActivePasswordRecoverySession(client)).resolves.toEqual({
      ok: true,
      user: { id: USER_ID },
    });

    mocks.cookieGet.mockReturnValue(undefined);
    await expect(requireActivePasswordRecoverySession(client)).resolves.toEqual({
      ok: false,
      code: "no_recovery_session",
    });
  });

  it("maps revoked and provider-unavailable Auth state without reading the cookie", async () => {
    const client = {
      auth: { getUser: vi.fn(), getSession: vi.fn() },
      rpc: vi.fn(),
    };
    mocks.active.mockResolvedValueOnce({ ok: false, code: "session_revoked" });
    await expect(requireActivePasswordRecoverySession(client)).resolves.toEqual({
      ok: false,
      code: "no_recovery_session",
    });
    mocks.active.mockResolvedValueOnce({ ok: false, code: "auth_unavailable" });
    await expect(requireActivePasswordRecoverySession(client)).resolves.toEqual({
      ok: false,
      code: "auth_unavailable",
    });
    expect(client.auth.getSession).not.toHaveBeenCalled();
  });
});
