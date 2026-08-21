import "server-only";

type AuthUser = {
  id: string;
  email?: string | null;
};

type AuthFailure = {
  status?: number;
  code?: string;
  name?: string;
};

export type ActiveAuthSessionResult =
  | { ok: true; user: AuthUser }
  | {
      ok: false;
      code: "unauthenticated" | "session_revoked" | "auth_unavailable";
    };

export type ActiveAuthSessionClient = {
  auth: {
    getUser(): Promise<{
      data: { user: AuthUser | null };
      error: AuthFailure | null;
    }>;
  };
  rpc(name: "current_auth_session_is_active"): PromiseLike<{
    data: boolean | null;
    error: unknown;
  }>;
};

/**
 * Fail-closed server boundary for security-sensitive authenticated actions.
 *
 * getUser() makes Auth validate the bearer/cookie instead of trusting locally
 * decoded claims. The RPC then proves the JWT session_id still exists for the
 * same subject, closing the window between explicit revocation and JWT expiry.
 */
export async function requireActiveAuthSession(
  client: ActiveAuthSessionClient,
): Promise<ActiveAuthSessionResult> {
  let authResult: Awaited<ReturnType<typeof client.auth.getUser>>;
  try {
    authResult = await client.auth.getUser();
  } catch {
    return { ok: false, code: "auth_unavailable" };
  }

  if (authResult.error) {
    const status = authResult.error.status;
    if (status === 400 || status === 401 || status === 403) {
      return { ok: false, code: "unauthenticated" };
    }
    return { ok: false, code: "auth_unavailable" };
  }
  if (!authResult.data.user?.id) {
    return { ok: false, code: "unauthenticated" };
  }

  let sessionResult: Awaited<ReturnType<typeof client.rpc>>;
  try {
    sessionResult = await client.rpc("current_auth_session_is_active");
  } catch {
    return { ok: false, code: "auth_unavailable" };
  }
  if (sessionResult.error) {
    return { ok: false, code: "auth_unavailable" };
  }
  if (sessionResult.data !== true) {
    return { ok: false, code: "session_revoked" };
  }

  return { ok: true, user: authResult.data.user };
}
