"use server";

import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import {
  getAvailableTimeSlotsStrict,
  type TimeSlot,
} from "@/shared/booking/getAvailableTimeSlots";
import { isValidBookingClosedDate } from "@/shared/booking/parseBookingClosedDates";
import { loadGuidedBookingPreview } from "@/shared/dashboard/loadGuidedBookingPreview";
import { ymdToLocalNoon } from "@/shared/lib/localDateYmd";

export type GuidedBookingPreviewAvailabilityInput = {
  slug: string;
  serviceId: string;
  staffId: string;
  dateYmd: string;
};

export type GuidedBookingPreviewAvailabilityResult =
  | { ok: true; dateYmd: string; slots: TimeSlot[] }
  | {
      ok: false;
      reason:
        | "unauthorized"
        | "disabled"
        | "unavailable"
        | "invalid_selection"
        | "invalid_date"
        | "resource_mode_not_proven";
    };

/**
 * Authenticated, read-only availability proof for Guided Setup.
 *
 * Every request reloads the canonical preview boundary, so stale client props
 * cannot bypass tenant, role, feature-flag, service, staff, or capability
 * checks. The strict slot reader treats backend errors as unavailable and this
 * action intentionally imports no booking, waitlist, OTP, payment, provider,
 * notification, or privileged mutation path.
 */
export async function loadGuidedBookingPreviewAvailability(
  input: GuidedBookingPreviewAvailabilityInput,
): Promise<GuidedBookingPreviewAvailabilityResult> {
  if (
    !input ||
    typeof input.slug !== "string" ||
    typeof input.serviceId !== "string" ||
    typeof input.staffId !== "string" ||
    typeof input.dateYmd !== "string"
  ) {
    return { ok: false, reason: "invalid_selection" };
  }

  const preview = await loadGuidedBookingPreview(input.slug);
  if (!preview.ok) return preview;

  const { data } = preview;
  if (data.salon.resourcesEnabled) {
    return { ok: false, reason: "resource_mode_not_proven" };
  }

  const service = data.services.find(
    (candidate) => candidate.id === input.serviceId,
  );
  if (!service || service.totalMinutes <= 0) {
    return { ok: false, reason: "invalid_selection" };
  }

  const eligibleStaffIds = new Set(
    (data.capabilityRows ?? [])
      .filter((row) => row.serviceId === service.id)
      .map((row) => row.staffId),
  );
  const eligibleStaff = data.staff.filter((staff) =>
    eligibleStaffIds.has(staff.id),
  );
  if (eligibleStaff.length === 0) {
    return { ok: false, reason: "unavailable" };
  }

  const requestedStaffId = input.staffId.trim();
  if (
    requestedStaffId !== BOOKING_ANY_STAFF_ID &&
    (!data.salon.staffSelectionEnabled ||
      !eligibleStaffIds.has(requestedStaffId))
  ) {
    return { ok: false, reason: "invalid_selection" };
  }

  const dateYmd = input.dateYmd.trim();
  if (
    dateYmd !== input.dateYmd ||
    !isValidBookingClosedDate(dateYmd) ||
    dateYmd < data.previewWindow.firstDateYmd ||
    dateYmd > data.previewWindow.lastDateYmd
  ) {
    return { ok: false, reason: "invalid_date" };
  }

  const durations = data.services
    .map((candidate) => candidate.totalMinutes)
    .filter((duration) => duration > 0);
  const result = await getAvailableTimeSlotsStrict({
    salonId: data.salon.id,
    openingHoursRaw: data.salon.openingHoursRaw,
    selectedDate: ymdToLocalNoon(dateYmd),
    staffId: requestedStaffId,
    staffList: eligibleStaff.map((staff) => ({
      id: staff.id,
      name: staff.name,
      job_role: staff.jobRole,
    })),
    serviceDurationMinutes: service.totalMinutes,
    trailingBufferMinutes: service.bufferMinutes,
    closedDateYmdSet: new Set(data.salon.bookingClosedDates),
    shortestServiceMinutes:
      durations.length > 0 ? Math.min(...durations) : 0,
    leadMinutes: data.salon.bookingLeadMinutes,
    timezone: data.salon.timezone,
  });

  return result.ok
    ? { ok: true, dateYmd, slots: result.slots }
    : { ok: false, reason: "unavailable" };
}
