import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  requireActiveAuthSession,
  type ActiveAuthSessionClient,
} from "../requireActiveAuthSession";

const getUser = vi.fn();
const rpc = vi.fn();
const client = { auth: { getUser }, rpc } as unknown as ActiveAuthSessionClient;

describe("requireActiveAuthSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({
      data: { user: { id: "51340000-0000-4000-8000-000000000001" } },
      error: null,
    });
    rpc.mockResolvedValue({ data: true, error: null });
  });

  it.each(["expired JWT", "malformed JWT", "wrong-audience JWT"])(
    "fails closed for an Auth-rejected %s",
    async () => {
      getUser.mockResolvedValue({
        data: { user: null },
        error: { status: 401, code: "bad_jwt" },
      });
      await expect(requireActiveAuthSession(client)).resolves.toEqual({
        ok: false,
        code: "unauthenticated",
      });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("rejects a cryptographically valid JWT after its session is revoked", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(requireActiveAuthSession(client)).resolves.toEqual({
      ok: false,
      code: "session_revoked",
    });
  });

  it("fails closed when refresh/Auth validation is unavailable", async () => {
    getUser.mockRejectedValue(new Error("refresh failed"));
    await expect(requireActiveAuthSession(client)).resolves.toEqual({
      ok: false,
      code: "auth_unavailable",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when the session lookup is unavailable", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db unavailable" } });
    await expect(requireActiveAuthSession(client)).resolves.toEqual({
      ok: false,
      code: "auth_unavailable",
    });
  });

  it("returns the Auth-validated user only after the active-session proof", async () => {
    await expect(requireActiveAuthSession(client)).resolves.toEqual({
      ok: true,
      user: { id: "51340000-0000-4000-8000-000000000001" },
    });
    expect(rpc).toHaveBeenCalledWith("current_auth_session_is_active");
  });
});
