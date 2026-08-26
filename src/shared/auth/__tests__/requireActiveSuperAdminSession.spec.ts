import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  requireActive: vi.fn(),
  getRole: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/shared/auth/requireActiveAuthSession", () => ({
  requireActiveAuthSession: mocks.requireActive,
}));
vi.mock("@/shared/lib/superadmin", () => ({
  getSuperAdminRole: mocks.getRole,
}));

import {
  clearInactiveServerSession,
  requireActiveSuperAdminSession,
} from "../requireActiveSuperAdminSession";

describe("requireActiveSuperAdminSession", () => {
  const supabase = { auth: { signOut: vi.fn() } };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue(supabase);
  });

  it("does not read the privileged role when the session is revoked", async () => {
    mocks.requireActive.mockResolvedValue({
      ok: false,
      code: "session_revoked",
    });

    await expect(requireActiveSuperAdminSession()).resolves.toEqual({
      ok: false,
      code: "session_revoked",
      supabase,
    });
    expect(mocks.getRole).not.toHaveBeenCalled();
  });

  it("returns the active user, role, and request-scoped client", async () => {
    mocks.requireActive.mockResolvedValue({
      ok: true,
      user: { id: "operator", email: "operator@example.test" },
    });
    mocks.getRole.mockResolvedValue("founder");

    await expect(requireActiveSuperAdminSession()).resolves.toEqual({
      ok: true,
      user: { id: "operator", email: "operator@example.test" },
      role: "founder",
      supabase,
    });
  });

  it("fails closed when role membership has been revoked", async () => {
    mocks.requireActive.mockResolvedValue({
      ok: true,
      user: { id: "operator" },
    });
    mocks.getRole.mockResolvedValue(null);

    await expect(requireActiveSuperAdminSession()).resolves.toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("clears only the local session and tolerates Auth cleanup outages", async () => {
    supabase.auth.signOut.mockRejectedValueOnce(new Error("auth unavailable"));
    await expect(clearInactiveServerSession(supabase as never)).resolves.toBeUndefined();
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
