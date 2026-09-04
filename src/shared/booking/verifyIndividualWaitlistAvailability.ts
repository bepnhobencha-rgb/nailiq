import "server-only";

import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { getAvailableTimeSlotsStrict } from "@/shared/booking/getAvailableTimeSlots";
import { loadBookingServicesForSalonSlug } from "@/shared/booking/loadBookingServices";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import {
  buildCapabilityMap,
  filterStaffCapableForService,
} from "@/shared/booking/staffCapability";
import { ymdToLocalNoon } from "@/shared/lib/localDateYmd";

export type IndividualWaitlistAvailability =
  | { outcome: "slot_available"; slotLabel: string }
  | { outcome: "slot_unavailable" }
  | { outcome: "availability_unverified" };

export async function verifyIndividualWaitlistAvailability(input: {
  salonSlug: string;
  salonId: string;
  serviceId: string;
  staffId: string | null;
  bookingDateYmd: string;
  preferredSlotLabel: string | null;
}): Promise<IndividualWaitlistAvailability> {
  try {
    const booking = await loadBookingServicesForSalonSlug(input.salonSlug);
    if (
      !booking ||
      !booking.proofComplete ||
      booking.salon.id !== input.salonId ||
      !booking.salon.timezone
    ) {
      return { outcome: "availability_unverified" };
    }

    const service = booking.services.find((item) => item.id === input.serviceId);
    if (!service || service.totalMinutes <= 0) {
      return { outcome: "availability_unverified" };
    }

    const capabilities = buildCapabilityMap(booking.capabilityRows);
    const capableStaff = filterStaffCapableForService(
      booking.staff,
      capabilities,
      service.id,
    );
    if (
      input.staffId &&
      !capableStaff.some((staff) => staff.id === input.staffId)
    ) {
      return { outcome: "slot_unavailable" };
    }

    const requiredKinds = new Set(service.requiredResourceKinds ?? []);
    const eligibleResources =
      service.resourceRequirementMode === "specific"
        ? booking.resources.filter((resource) => requiredKinds.has(resource.kind))
        : booking.resources;
    const requiresResource =
      booking.salon.resourcesEnabled &&
      service.resourceRequirementMode !== "none";
    if (requiresResource && eligibleResources.length === 0) {
      return { outcome: "slot_unavailable" };
    }

    const shortestServiceMinutes = booking.services.reduce(
      (shortest, item) =>
        item.totalMinutes > 0 && (shortest === 0 || item.totalMinutes < shortest)
          ? item.totalMinutes
          : shortest,
      0,
    );
    const result = await getAvailableTimeSlotsStrict({
      salonId: booking.salon.id,
      openingHoursRaw: booking.salon.opening_hours,
      selectedDate: ymdToLocalNoon(input.bookingDateYmd),
      staffId: input.staffId ?? BOOKING_ANY_STAFF_ID,
      staffList: capableStaff,
      serviceDurationMinutes: service.totalMinutes,
      trailingBufferMinutes: service.bufferMinutes,
      closedDateYmdSet: parseBookingClosedDateSet(
        booking.salon.booking_closed_dates,
      ),
      shortestServiceMinutes,
      leadMinutes: booking.salon.bookingLeadMinutes,
      timezone: booking.salon.timezone,
      requiresResource,
      eligibleResourceIds: eligibleResources.map((resource) => resource.id),
    });
    if (!result.ok) return { outcome: "availability_unverified" };

    if (input.preferredSlotLabel) {
      const exact = result.slots.find(
        (slot) => slot.label === input.preferredSlotLabel,
      );
      if (!exact) return { outcome: "availability_unverified" };
      return exact.available
        ? { outcome: "slot_available", slotLabel: exact.label }
        : { outcome: "slot_unavailable" };
    }

    const firstAvailable = result.slots.find((slot) => slot.available);
    return firstAvailable
      ? { outcome: "slot_available", slotLabel: firstAvailable.label }
      : { outcome: "slot_unavailable" };
  } catch {
    return { outcome: "availability_unverified" };
  }
}
