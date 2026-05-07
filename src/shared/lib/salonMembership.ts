import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeSalonMemberRole,
  type SalonMemberRole,
} from "@/shared/lib/salonMemberRole";

/**
 * Result of mapping an authenticated user to a salon to land on.
 *
 * - `needsPicker: false` — exactly one membership; route straight to
 *   `dashboardPathForRole(slug, role)`.
 * - `needsPicker: true` — more than one membership; route to `/choose-salon`
 *   so the user picks which salon to manage.
 *
 * `null` (returned by the helper, not part of this union) means the user has
 * no membership at all → caller routes to `/register/setup`.
 */
export type ResolvedSalonMembership =
  | { needsPicker: false; slug: string; role: SalonMemberRole }
  | { needsPicker: true; slug: null; role: null };

/**
 * Map an authenticated user to either a single-salon redirect target or a
 * picker signal when they own multiple salons.
 *
 * Replaces the previous "first row wins" behavior — multi-salon owners now
 * see `/choose-salon` instead of being silently routed to whichever row came
 * back first.
 */
export async function resolveRoleAndSlugForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<ResolvedSalonMembership | null> {
  const { data: memRows, error: memErr } = await supabase
    .from("salon_members")
    .select("salon_id, role")
    .eq("user_id", userId);

  if (memErr) {
    console.error("[resolveRoleAndSlugForUser] salon_members", memErr);
    return null;
  }

  const valid = (memRows ?? []).filter((r) => Boolean(r?.salon_id));
  if (valid.length === 0) return null;
  if (valid.length > 1) {
    return { needsPicker: true, slug: null, role: null };
  }

  const only = valid[0];
  const { data: salRow, error: salErr } = await supabase
    .from("salons")
    .select("slug")
    .eq("id", only.salon_id)
    .maybeSingle();

  if (salErr) {
    console.error("[resolveRoleAndSlugForUser] salons", salErr);
    return null;
  }

  const slug = salRow?.slug?.trim();
  if (!slug) return null;

  return {
    needsPicker: false,
    slug: String(slug),
    role: normalizeSalonMemberRole(only.role),
  };
}
