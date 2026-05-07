import { NextResponse, type NextRequest } from "next/server";
import { dashboardPathForRole } from "@/shared/lib/salonMemberRole";
import { resolveRoleAndSlugForUser } from "@/shared/lib/salonMembership";
import { createClient } from "@/shared/lib/supabase/server";

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

  const supabase = await createClient();
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
  if (!resolved) {
    return NextResponse.redirect(new URL("/register/setup", request.url));
  }
  if (resolved.needsPicker) {
    return NextResponse.redirect(new URL("/choose-salon", request.url));
  }
  return NextResponse.redirect(
    new URL(
      dashboardPathForRole(resolved.slug, resolved.role),
      request.url,
    ),
  );
}
