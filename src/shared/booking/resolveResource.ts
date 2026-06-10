/**
 * Resource-layer scheduling helpers (Phase 1). Shared by the desk + public +
 * sync booking paths. All callers gate on `resources_enabled` first, so these
 * only run for resource-mode salons.
 */

// Loosely typed: salon_resources / resources_enabled aren't in database.types yet,
// and callers pass different Supabase clients (service-role, anon, RLS).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any };

const SKIP_STATUSES = ["cancelled", "no_show", "waiting"];

export interface ResourceMode {
  enabled: boolean;
  axis: "staff" | "resource";
}

/** Read a salon's resource-mode config. */
export async function getResourceMode(db: Db, salonId: string): Promise<ResourceMode> {
  const { data } = await db
    .from("salons")
    .select("resources_enabled, primary_grid_axis")
    .eq("id", salonId)
    .maybeSingle();
  const row = (data as { resources_enabled?: unknown; primary_grid_axis?: unknown } | null) ?? null;
  return {
    enabled: row?.resources_enabled === true,
    axis: row?.primary_grid_axis === "resource" ? "resource" : "staff",
  };
}

/**
 * Pick a free resource for [startUtcIso, endUtcIso). Prefers `preferredId` when
 * given and free, else the first active resource (by display_order) with no
 * overlapping live booking. Returns null when every resource is busy.
 */
export async function resolveFreeResource(
  db: Db,
  salonId: string,
  startUtcIso: string,
  endUtcIso: string,
  preferredId?: string | null,
): Promise<{ resourceId: string | null; total: number; busy: number }> {
  const { data: resRows } = await db
    .from("salon_resources")
    .select("id")
    .eq("salon_id", salonId)
    .eq("status", "active")
    .is("deleted_at", null)
    .order("display_order", { ascending: true });
  const active: string[] = ((resRows as { id: string }[]) ?? []).map((r) => r.id);
  if (active.length === 0) return { resourceId: null, total: 0, busy: 0 };

  const { data: occRows } = await db
    .from("bookings")
    .select("resource_id, status")
    .eq("salon_id", salonId)
    .not("resource_id", "is", null)
    .lt("start_time_utc", endUtcIso)
    .gt("end_time_utc", startUtcIso);
  const busy = new Set<string>();
  for (const b of (occRows as { resource_id: string; status: string }[]) ?? []) {
    if (!SKIP_STATUSES.includes(b.status)) busy.add(b.resource_id);
  }

  if (preferredId && active.includes(preferredId) && !busy.has(preferredId)) {
    return { resourceId: preferredId, total: active.length, busy: busy.size };
  }
  for (const id of active) {
    if (!busy.has(id)) return { resourceId: id, total: active.length, busy: busy.size };
  }
  return { resourceId: null, total: active.length, busy: busy.size };
}
