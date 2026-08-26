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

const TRANSIENT_AUTH_RETRY_DELAYS_MS = [25, 75] as const;

async function waitBeforeAuthRetry(attempt: number): Promise<void> {
  const delay = TRANSIENT_AUTH_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) return;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

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
  let authResult: Awaited<ReturnType<typeof client.auth.getUser>> | null = null;
  for (let attempt = 0; attempt <= TRANSIENT_AUTH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      authResult = await client.auth.getUser();
    } catch {
      authResult = null;
    }

    // Credential denials are authoritative and must never be retried. Network
    // errors and provider 5xx failures get two short bounded retries so a
    // healthy session is not converted into a login redirect during a brief
    // connection-pool handoff.
    const status = authResult?.error?.status;
    if (
      authResult &&
      (!authResult.error || status === 400 || status === 401 || status === 403)
    ) {
      break;
    }
    await waitBeforeAuthRetry(attempt);
  }

  if (!authResult) {
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

  let sessionResult: Awaited<ReturnType<typeof client.rpc>> | null = null;
  for (let attempt = 0; attempt <= TRANSIENT_AUTH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      sessionResult = await client.rpc("current_auth_session_is_active");
    } catch {
      sessionResult = null;
    }
    if (sessionResult && !sessionResult.error) break;
    await waitBeforeAuthRetry(attempt);
  }
  if (!sessionResult || sessionResult.error) {
    return { ok: false, code: "auth_unavailable" };
  }
  if (sessionResult.data !== true) {
    return { ok: false, code: "session_revoked" };
  }

  return { ok: true, user: authResult.data.user };
}
