/**
 * Staff capability for booking — does staff X know how to do service Y?
 *
 * Storage: `staff_services` JOIN table (migration
 * `20260506120000_add_staff_services.sql`). **Not** `staff.skills` — that
 * array column was dropped in
 * `20260512500000_drop_staff_skills_column.sql` because it was never
 * wired into the booking flow (it only fed a never-shipped
 * receptionist-side skill-chip UI). The JOIN table is the right shape
 * here: FK-enforced (deleting a service CASCADEs its capability rows),
 * soft-delete-aware via filtered SELECTs, and RLS-friendly.
 *
 * Backward-compat semantic: a salon with zero `staff_services` rows is
 * treated as "every staff can do every service" — kept so legacy salons
 * that haven't migrated through the StaffSetupPanel still book through
 * the front door. Once the panel writes any row for the salon, the
 * whitelist takes over.
 */

/**
 * staff_id → Set<service_id>. `null` means: zero rows for this salon, so
 * every staff is capable of every service (backward-compatible fallback).
 */
export type StaffCapabilityMap = Map<string, Set<string>> | null;

export type StaffCapabilityRow = {
  staff_id: string;
  service_id: string;
};

export function buildCapabilityMap(
  rows: ReadonlyArray<StaffCapabilityRow> | null,
): StaffCapabilityMap {
  if (!rows || rows.length === 0) return null;
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    let bucket = map.get(r.staff_id);
    if (!bucket) {
      bucket = new Set();
      map.set(r.staff_id, bucket);
    }
    bucket.add(r.service_id);
  }
  return map;
}

export function isStaffCapableForService(
  cap: StaffCapabilityMap,
  staffId: string,
  serviceId: string,
): boolean {
  if (cap === null) return true;
  return cap.get(staffId)?.has(serviceId) ?? false;
}

export function filterStaffCapableForService<T extends { id: string }>(
  staff: ReadonlyArray<T>,
  cap: StaffCapabilityMap,
  serviceId: string | null | undefined,
): readonly T[] {
  if (cap === null || !serviceId) return staff;
  return staff.filter((s) => cap.get(s.id)?.has(serviceId));
}

/** For bookings that include an addon — staff must be capable of every service in the bundle. */
export function filterStaffCapableForServices<T extends { id: string }>(
  staff: ReadonlyArray<T>,
  cap: StaffCapabilityMap,
  serviceIds: readonly string[],
): readonly T[] {
  if (cap === null) return staff;
  return staff.filter((s) => {
    const bucket = cap.get(s.id);
    if (!bucket) return false;
    return serviceIds.every((id) => bucket.has(id));
  });
}
