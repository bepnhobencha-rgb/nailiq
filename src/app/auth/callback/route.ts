import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { dashboardPathForRole } from "@/shared/lib/salonMemberRole";
import { resolveRoleAndSlugForUser } from "@/shared/lib/salonMembership";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { claimInviteToken } from "@/shared/dashboard/inviteTokenActions";

export const dynamic = "force-dynamic";
// Supabase ssr server client + cookie writes are exercised against the Node
// runtime in the rest of the app — pin here to avoid edge-runtime surprises.
export const runtime = "nodejs";

/**
 * OAuth + email magic-link callback.
 *
 * `signInWithOAuth({ provider: "google" })` and
 * `signInWithOtp({ email })` both finish here with a `?code=…` query
 * parameter. Exchange it for a Supabase session, then route by role:
 *
 * - existing `salon_members` row → `dashboardPathForRole(slug, role)`
 * - no membership → `/register/setup` (new user picks a salon name)
 *
 * Errors are surfaced via `?error=…` on `/login` so the caller sees a
 * message instead of a silent redirect loop.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  // QR invite token passed via redirectTo → /auth/callback?invite=TOKEN
  const inviteToken = url.searchParams.get("invite");
  const errorDescription =
    url.searchParams.get("error_description") ??
    url.searchParams.get("error");

  if (errorDescription) {
    const dest = new URL("/login", request.url);
    dest.searchParams.set("error", errorDescription);
    return NextResponse.redirect(dest);
  }

  if (!code) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Collect cookies from exchangeCodeForSession so we can attach them
  // directly to the redirect response. Using the shared createClient()
  // (which writes via `cookieStore.set()` from `next/headers`) is NOT
  // reliable here because explicitly-returned NextResponse objects are a
  // separate response instance — the cookies end up on the wrong object
  // and the browser never receives the session, causing a redirect loop
  // back to /register on the first OAuth attempt.
  const pendingCookies: Array<{
    name: string;
    value: string;
    options?: Record<string, unknown>;
  }> = [];

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          pendingCookies.push(...cookiesToSet);
        },
      },
    },
  );

  const { error: exchangeErr } =
    await supabase.auth.exchangeCodeForSession(code);
  if (exchangeErr) {
    console.error("[auth/callback] exchangeCodeForSession", exchangeErr);
    const dest = new URL("/login", request.url);
    dest.searchParams.set("error", "session");
    return NextResponse.redirect(dest);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  let resolved = await resolveRoleAndSlugForUser(supabase, user.id);

  // QR / link invite: claim the invite token and create the membership row.
  // Runs before the email-reconcile path so a staff member who just signed up
  // via a QR link gets their membership instantly without needing a prior
  // Supabase invite email.
  if (inviteToken) {
    try {
      const claimed = await claimInviteToken(inviteToken, user.id);
      if (claimed.ok) {
        resolved = await resolveRoleAndSlugForUser(supabase, user.id);
      } else {
        console.warn("[auth/callback] invite claim failed:", claimed.error);
      }
    } catch (e) {
      console.error("[auth/callback] invite claim error:", e);
    }
  }

  // Staff invited by email often sign in with a DIFFERENT identity (e.g.
  // Google), which Supabase may register as a fresh auth user that has no
  // membership — so they'd be wrongly sent to /register/setup. Reconcile by
  // verified email: claim any membership held by another same-email account,
  // then re-resolve. Only runs on the no-membership path (no normal-login cost).
  if (!resolved && user.email) {
    try {
      const admin = createServiceRoleClient();
      const { data: claimed } = await admin.rpc(
        "claim_salon_memberships_by_email",
        { p_user_id: user.id },
      );
      if (claimed && Number(claimed) > 0) {
        resolved = await resolveRoleAndSlugForUser(supabase, user.id);
      }
    } catch (e) {
      console.error("[auth/callback] membership reconcile failed", e);
    }
  }

  let dest: URL;
  if (!resolved) {
    dest = new URL("/register/setup", request.url);
  } else if (resolved.needsPicker) {
    dest = new URL("/choose-salon", request.url);
  } else {
    dest = new URL(dashboardPathForRole(resolved.slug, resolved.role), request.url);
    // Audit the email/OAuth login (who / when / device / IP) for the Activity log.
    const xff = request.headers.get("x-forwarded-for");
    void (await import("@/shared/dashboard/recordAuthEvent")).recordAuthEvent({
      event: "login",
      userId: user.id,
      slug: resolved.slug,
      role: resolved.role,
      ip: (xff ? xff.split(",")[0]?.trim() : "") || request.headers.get("x-real-ip") || null,
      userAgent: request.headers.get("user-agent"),
    });
  }

  const response = NextResponse.redirect(dest);
  const secure = process.env.NODE_ENV === "production";
  for (const { name, value, options } of pendingCookies) {
    response.cookies.set(name, value, { ...options, secure });
  }
  return response;
}
