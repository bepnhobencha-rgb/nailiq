import "server-only";

import { cookies } from "next/headers";
import {
  type ActiveAuthSessionClient,
  requireActiveAuthSession,
} from "@/shared/auth/requireActiveAuthSession";
import {
  PASSWORD_RECOVERY_COOKIE,
  sessionIdFromAccessToken,
  verifyPasswordRecoveryCapability,
} from "@/shared/auth/passwordRecoverySecurity";

type RecoveryClient = ActiveAuthSessionClient & {
  auth: ActiveAuthSessionClient["auth"] & {
    getSession(): Promise<{
      data: { session: { access_token?: string | null } | null };
      error: unknown;
    }>;
  };
};

export async function requireActivePasswordRecoverySession(
  client: RecoveryClient,
): Promise<
  | { ok: true; user: { id: string; email?: string | null } }
  | { ok: false; code: "no_recovery_session" | "auth_unavailable" }
> {
  const active = await requireActiveAuthSession(client);
  if (!active.ok) {
    return {
      ok: false,
      code: active.code === "auth_unavailable" ? "auth_unavailable" : "no_recovery_session",
    };
  }

  try {
    const session = await client.auth.getSession();
    const sessionId = sessionIdFromAccessToken(session.data.session?.access_token);
    const token = (await cookies()).get(PASSWORD_RECOVERY_COOKIE)?.value;
    if (
      session.error ||
      !sessionId ||
      !verifyPasswordRecoveryCapability({
        token,
        userId: active.user.id,
        sessionId,
      })
    ) {
      return { ok: false, code: "no_recovery_session" };
    }
    return { ok: true, user: active.user };
  } catch {
    return { ok: false, code: "auth_unavailable" };
  }
}
