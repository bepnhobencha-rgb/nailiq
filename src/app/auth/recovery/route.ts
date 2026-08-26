import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/shared/lib/supabase/server";
import { clearSuperAdminCache, getSuperAdminRole } from "@/shared/lib/superadmin";
import { requireActiveAuthSession } from "@/shared/auth/requireActiveAuthSession";
import {
  issuePasswordRecoveryCapability,
  isPasswordRecoverySecurityConfigured,
  PASSWORD_RECOVERY_COOKIE,
  PASSWORD_RECOVERY_MAX_AGE_SECONDS,
  passwordRecoveryDestination,
  sessionIdFromAccessToken,
  verifyPasswordRecoveryIntent,
} from "@/shared/auth/passwordRecoverySecurity";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Password recovery callback.
 *
 * Supabase's `resetPasswordForEmail({ redirectTo })` sends the user
 * here with `?code=…` (PKCE) after they click the email link. A route
 * handler — not a server component — is the only context where
 * `@supabase/ssr` can persist the freshly-minted session cookies, so
 * the exchange has to happen here before redirecting on.
 *
 * After exchanging the code for a session, we determine whether the
 * user is a superadmin or a salon owner to route them to the correct
 * reset-password page.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const requestedSurface = url.searchParams.get("surface");
  const recoveryIntent = url.searchParams.get("state");
  const surface = requestedSurface === "superadmin" ? "superadmin" : "salon";
  let invalidDestination: URL;
  let unavailableDestination: URL;
  try {
    invalidDestination = passwordRecoveryDestination(
      surface === "superadmin"
        ? "/superadmin/forgot-password"
        : "/login/forgot-password",
      "invalid_or_expired",
    );
    unavailableDestination = passwordRecoveryDestination(
      surface === "superadmin"
        ? "/superadmin/forgot-password"
        : "/login/forgot-password",
      "temporarily_unavailable",
    );
  } catch {
    return new NextResponse(null, { status: 503 });
  }

  if (!code || code.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(code)) {
    return NextResponse.redirect(invalidDestination);
  }
  if (!isPasswordRecoverySecurityConfigured()) {
    return NextResponse.redirect(unavailableDestination);
  }
  let recoveryIntentValid = false;
  try {
    recoveryIntentValid = verifyPasswordRecoveryIntent({
      token: recoveryIntent,
      surface,
    });
  } catch {
    return NextResponse.redirect(unavailableDestination);
  }
  if (!recoveryIntentValid) return NextResponse.redirect(invalidDestination);

  const rate = await consumePublicRequestRateLimit({
    request,
    scope: "password-recovery-exchange",
    identity: [code],
    ipLimits: [
      [20, 300],
      [60, 3_600],
    ],
    identityLimits: [[3, 3_600]],
  });
  if (rate !== "allowed") {
    return NextResponse.redirect(
      rate === "unavailable" ? unavailableDestination : invalidDestination,
    );
  }

  let supabase: Awaited<ReturnType<typeof createClient>> | null = null;
  try {
    supabase = await createClient();
    const { data: exchange, error } =
      await supabase.auth.exchangeCodeForSession(code);
    if (error || !exchange.user || !exchange.session) {
      return NextResponse.redirect(invalidDestination);
    }
    if (
      !verifyPasswordRecoveryIntent({
        token: recoveryIntent,
        surface,
        email: exchange.user.email,
      })
    ) {
      await supabase.auth.signOut({ scope: "global" });
      return NextResponse.redirect(invalidDestination);
    }

    const active = await requireActiveAuthSession(supabase);
    const sessionId = sessionIdFromAccessToken(exchange.session.access_token);
    if (!active.ok) {
      await supabase.auth.signOut({ scope: "local" });
      return NextResponse.redirect(
        active.code === "auth_unavailable"
          ? unavailableDestination
          : invalidDestination,
      );
    }
    if (active.user.id !== exchange.user.id || !sessionId) {
      await supabase.auth.signOut({ scope: "local" });
      return NextResponse.redirect(invalidDestination);
    }

    let destination:
      | ReturnType<typeof passwordRecoveryDestination>
      | null = null;
    if (surface === "superadmin") {
      clearSuperAdminCache(active.user.id);
      const superadminRole = await getSuperAdminRole(active.user.id);
      if (superadminRole) {
        destination = passwordRecoveryDestination(
          "/superadmin/reset-password",
        );
      }
    } else {
      const { data: salonMember, error: membershipError } = await supabase
        .from("salon_members")
        .select("id")
        .eq("user_id", active.user.id)
        .limit(1)
        .maybeSingle();
      if (membershipError) {
        await supabase.auth.signOut({ scope: "local" });
        return NextResponse.redirect(unavailableDestination);
      }
      if (salonMember) {
        destination = passwordRecoveryDestination("/login/reset-password");
      }
    }

    if (!destination) {
      await supabase.auth.signOut({ scope: "global" });
      return NextResponse.redirect(invalidDestination);
    }

    const capability = issuePasswordRecoveryCapability({
      userId: active.user.id,
      sessionId,
    });
    const response = NextResponse.redirect(destination);
    response.cookies.set(PASSWORD_RECOVERY_COOKIE, capability, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: PASSWORD_RECOVERY_MAX_AGE_SECONDS,
    });
    return response;
  } catch {
    if (supabase) {
      try {
        await supabase.auth.signOut({ scope: "global" });
      } catch {
        // The callback still returns no capability or privileged destination.
      }
    }
    return NextResponse.redirect(unavailableDestination);
  }
}
