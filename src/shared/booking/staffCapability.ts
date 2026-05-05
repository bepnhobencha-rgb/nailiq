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
