"use server";

import { dashboardPathForRole } from "@/shared/lib/salonMemberRole";
import { resolveRoleAndSlugForUser } from "@/shared/lib/salonMembership";
import { createClient } from "@/shared/lib/supabase/server";

/**
 * Mirrors the routing logic in `/auth/callback/route.ts` for callers that
 * already have a Supabase session (email + password sign-in / sign-up).
 *
 * Returns the path the client should navigate to:
 *   - no session              → `/register`
 *   - has membership (single) → `dashboardPathForRole(slug, role)`
 *   - has membership (multi)  → `/choose-salon`
 *   - no membership           → `/register/setup`
 *
 * Keep this in sync with `/auth/callback/route.ts` — the OAuth and
 * password flows must land on the same surface.
 */
export async function resolvePostAuthRedirect(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "/register";

  // If email is not confirmed yet, require email verification before accessing dashboard.
  // User must click the confirmation link sent to their email during signup.
  if (!user.email_confirmed_at) {
    return "/register";
  }

  const resolved = await resolveRoleAndSlugForUser(supabase, user.id);
  if (!resolved) return "/register/setup";
  if (resolved.needsPicker) return "/choose-salon";
  return dashboardPathForRole(resolved.slug, resolved.role);
}
