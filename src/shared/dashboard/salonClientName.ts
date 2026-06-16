import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * The per-salon display-name override for a customer (tenant-isolated rename),
 * or null when the salon hasn't renamed them. Read sites that show the shared
 * `client_profiles.name` (profile-360, typeahead, returning-customer autofill)
 * prefer this so a salon's correction shows everywhere WITHIN that salon —
 * without ever touching the shared profile that other tenants see.
 */
export async function getSalonDisplayName(
  salonId: string,
  phone: string,
): Promise<string | null> {
  const p = (phone ?? "").trim();
  if (!salonId || !p) return null;
  try {
    const { data } = await createServiceRoleClient()
      .from("salon_client_names" as never)
      .select("display_name")
      .eq("salon_id", salonId)
      .eq("phone", p)
      .maybeSingle();
    const v = (data as { display_name?: string | null } | null)?.display_name?.trim();
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}
