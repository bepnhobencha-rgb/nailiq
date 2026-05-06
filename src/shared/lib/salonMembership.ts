import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeSalonMemberRole,
  type SalonMemberRole,
} from "@/shared/lib/salonMemberRole";

export type ResolvedSalonMembership = {
  slug: string;
  role: SalonMemberRole;
};

/**
 * Look up the user's first `salon_members` row and return `{ slug, role }`.
 * Returns `null` when the user has no membership yet — callers route those
 * users to `/register/setup` to create a salon.
 *
 * Multi-salon users hit `.limit(1)` "first row wins" — same semantics as
 * `finalizeRegisterSessionAfterPhoneOtp` to keep redirect behavior consistent
 * across the phone, OAuth, and magic-link paths.
 */
export async function resolveRoleAndSlugForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<ResolvedSalonMembership | null> {
  const { data: memRow, error: memErr } = await supabase
    .from("salon_members")
    .select("salon_id, role")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (memErr) {
    console.error("[resolveRoleAndSlugForUser] salon_members", memErr);
    return null;
  }
  if (!memRow?.salon_id) return null;

  const { data: salRow, error: salErr } = await supabase
    .from("salons")
    .select("slug")
    .eq("id", memRow.salon_id)
    .maybeSingle();

  if (salErr) {
    console.error("[resolveRoleAndSlugForUser] salons", salErr);
    return null;
  }

  const slug = salRow?.slug?.trim();
  if (!slug) return null;

  return {
    slug: String(slug),
    role: normalizeSalonMemberRole(memRow.role),
  };
}
