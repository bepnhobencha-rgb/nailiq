import { createClient } from "@/shared/lib/supabase/server";

/**
 * Salon member role resolution.
 *
 * Source of truth = `public.salon_members` table, queried with
 * the authenticated user's session context (RLS applies).
 *
 * Returns the role ('owner' or 'staff') if the user has any salon
 * membership, null otherwise.
 */

export type SalonMemberRole = "owner" | "staff";

/**
 * Resolves the salon member role for the current authenticated user,
 * or null if they don't have a salon membership.
 *
 * Returns the first membership found (users typically have one salon,
 * but multi-tenant support is possible).
 */
export async function getCurrentSalonMemberRole(): Promise<
  SalonMemberRole | null
> {
  try {
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("salon_members")
      .select("role")
      .limit(1)
      .single();

    if (error || !data) {
      return null;
    }

    const role = data.role as unknown;
    if (role === "owner" || role === "staff") {
      return role;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Checks if the current user is a salon member (owner or staff).
 */
export async function isCurrentUserSalonMember(): Promise<boolean> {
  const role = await getCurrentSalonMemberRole();
  return role !== null;
}
