import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { dashboardPathForRole } from "@/shared/lib/salonMemberRole";
import { resolveRoleAndSlugForUser } from "@/shared/lib/salonMembership";

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

  const resolved = await resolveRoleAndSlugForUser(supabase, user.id);

  let dest: URL;
  if (!resolved) {
    dest = new URL("/register/setup", request.url);
  } else if (resolved.needsPicker) {
    dest = new URL("/choose-salon", request.url);
  } else {
    dest = new URL(dashboardPathForRole(resolved.slug, resolved.role), request.url);
  }

  const response = NextResponse.redirect(dest);
  const secure = process.env.NODE_ENV === "production";
  for (const { name, value, options } of pendingCookies) {
    response.cookies.set(name, value, { ...options, secure });
  }
  return response;
}
