import {
  buildCapabilityMap,
  filterStaffCapableForService,
  type StaffCapabilityRow,
} from "@/shared/booking/staffCapability";

/** Public-booking-compatible capability fallback for Phone Voice Any Staff. */
export function eligibleVoiceAnyStaff<T extends { id: string }>(
  activeSalonStaff: readonly T[],
  capabilityRows: readonly StaffCapabilityRow[],
  serviceId: string,
): readonly T[] {
  const activeIds = new Set(activeSalonStaff.map((staff) => staff.id));
  const validRows = capabilityRows.filter((row) => activeIds.has(row.staff_id));
  return filterStaffCapableForService(
    activeSalonStaff,
    buildCapabilityMap(validRows),
    serviceId,
  );
}
