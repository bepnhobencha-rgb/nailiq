import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const ID_BATCH_SIZE = 100;

/** Load explicit VIP recognition from the salon-client relationship. */
export async function loadSalonVipProfileIds(
  salonId: string,
  profileIds: Iterable<string>,
): Promise<Set<string>> {
  const ids = [...new Set(profileIds)].filter(Boolean);
  const vipIds = new Set<string>();
  const db = createServiceRoleClient();

  for (let start = 0; start < ids.length; start += ID_BATCH_SIZE) {
    const batch = ids.slice(start, start + ID_BATCH_SIZE);
    const { data, error } = await db
      .from("salon_clients" as never)
      .select("client_profile_id" as never)
      .eq("salon_id" as never, salonId)
      .eq("is_vip" as never, true)
      .in("client_profile_id" as never, batch as never);
    if (error) throw new Error("salon_vip_status_read_failed", { cause: error });
    for (const row of (data ?? []) as Array<{ client_profile_id?: string | null }>) {
      if (row.client_profile_id) vipIds.add(row.client_profile_id);
    }
  }

  return vipIds;
}

/** Resolve salon-scoped VIP flags for an already tenant-bounded phone set. */
export async function loadSalonVipPhones(
  salonId: string,
  phones: Iterable<string>,
): Promise<Set<string>> {
  const requested = [...new Set(phones)].filter(Boolean);
  const profilePhone = new Map<string, string>();
  const db = createServiceRoleClient();

  for (let start = 0; start < requested.length; start += ID_BATCH_SIZE) {
    const batch = requested.slice(start, start + ID_BATCH_SIZE);
    const { data, error } = await db
      .from("client_profiles" as never)
      .select("id, phone" as never)
      .in("phone" as never, batch as never)
      .is("deleted_at" as never, null);
    if (error) throw new Error("salon_vip_profile_lookup_failed", { cause: error });
    for (const row of (data ?? []) as Array<{ id?: string | null; phone?: string | null }>) {
      if (row.id && row.phone) profilePhone.set(row.id, row.phone);
    }
  }

  const vipIds = await loadSalonVipProfileIds(salonId, profilePhone.keys());
  return new Set(
    [...vipIds]
      .map((id) => profilePhone.get(id))
      .filter((value): value is string => Boolean(value)),
  );
}
