import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DeskBookingRequestState = {
  intentKey: string;
  requestId: string;
};

/** Client-only state transition: retries of one unchanged intent keep the same
 * UUID; editing any material field creates a new logical request. */
export function deskBookingRequestForIntent(
  current: DeskBookingRequestState | null,
  intentKey: string,
  generate: () => string = () => crypto.randomUUID(),
): DeskBookingRequestState {
  if (current?.intentKey === intentKey && isDeskBookingRequestId(current.requestId)) {
    return current;
  }
  return { intentKey, requestId: generate() };
}

/** Stable only in memory; it is never logged or persisted. */
export function deskBookingIntentKey(input: {
  salonId: string;
  serviceId: string;
  addonServiceIds?: readonly string[];
  staffId: string;
  bookingDateYmd: string;
  timeSlot: string;
  clientName: string;
  clientPhone: string;
  clientEmail?: string | null;
  clientNotes?: string | null;
  resourceId?: string | null;
}): string {
  const phoneDigits = input.clientPhone.replace(/\D/g, "");
  return JSON.stringify({
    salonId: input.salonId.trim(),
    serviceId: input.serviceId.trim(),
    addonServiceIds: [...new Set(input.addonServiceIds ?? [])]
      .map((id) => id.trim().toLowerCase())
      .sort(),
    staffId: input.staffId.trim(),
    bookingDateYmd: input.bookingDateYmd.trim(),
    timeSlot: input.timeSlot.trim(),
    clientName: input.clientName.trim(),
    clientPhone: phoneDigits.length === 10 ? `1${phoneDigits}` : phoneDigits,
    clientEmail: input.clientEmail?.trim().toLowerCase() || null,
    clientNotes: input.clientNotes?.trim() || null,
    resourceId: input.resourceId ?? null,
  });
}

/** Material desk-group intent before server-side UTC/canonical pricing
 * resolution. Member order is significant because it defines organizer and
 * receipt allocation order. */
export function deskGroupIntentKey(input: {
  salonId: string;
  members: ReadonlyArray<{
    name: string;
    phone: string;
    email?: string | null;
    notes?: string | null;
    serviceId: string;
    staffId: string;
    staffRequestedByClient?: boolean;
    date: string;
    time: string;
    waveNumber?: number;
    addonServiceIds?: readonly string[];
  }>;
  seatTogether: boolean;
  language: "en" | "vi" | null;
  controlledAfterHours: boolean;
}): string {
  return JSON.stringify({
    salonId: input.salonId.trim(),
    members: input.members.map((member) => ({
      name: member.name.trim(),
      phone: member.phone.replace(/\D/g, ""),
      email: member.email?.trim().toLowerCase() || null,
      notes: member.notes?.trim() || null,
      serviceId: member.serviceId.trim().toLowerCase(),
      staffId: member.staffId.trim().toLowerCase(),
      staffRequestedByClient: member.staffRequestedByClient ?? true,
      date: member.date.trim(),
      time: member.time.trim(),
      waveNumber: member.waveNumber ?? 1,
      addonServiceIds: (member.addonServiceIds ?? []).map((id) => id.trim().toLowerCase()),
    })),
    seatTogether: input.seatTogether,
    language: input.language,
    controlledAfterHours: input.controlledAfterHours,
  });
}

export function isDeskBookingRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export type ExistingDeskBookingRequest = {
  id: string;
  salonId: string;
  serviceId: string;
  staffId: string | null;
  clientName: string;
  clientPhone: string;
  clientEmail: string | null;
  clientNotes: string | null;
  startTimeUtc: string;
  resourceId: string | null;
  addonServiceIds: readonly string[];
};

export type DeskBookingReplayIntent = {
  salonId: string;
  serviceId: string;
  requestedStaffId: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string | null;
  clientNotes: string | null;
  startTimeUtc: string;
  requestedResourceId: string | null;
  addonServiceIds: readonly string[];
};

function sameUuidSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left.map((id) => id.trim().toLowerCase()))].sort();
  const b = [...new Set(right.map((id) => id.trim().toLowerCase()))].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** A client request UUID is a lookup capability, not authorization. Before an
 * already-committed row can be replayed, bind it back to the authenticated
 * tenant and every user-controlled booking fact. Any-staff may reuse the staff
 * chosen by the first attempt; a specific-staff retry must match exactly. */
export function isSameDeskBookingRequest(
  existing: ExistingDeskBookingRequest,
  intent: DeskBookingReplayIntent,
): boolean {
  const existingStart = Date.parse(existing.startTimeUtc);
  const requestedStart = Date.parse(intent.startTimeUtc);
  return (
    existing.salonId === intent.salonId &&
    existing.serviceId === intent.serviceId &&
    existing.clientName.trim() === intent.clientName.trim() &&
    existing.clientPhone === intent.clientPhone &&
    (existing.clientEmail?.trim().toLowerCase() || null) ===
      (intent.clientEmail?.trim().toLowerCase() || null) &&
    (existing.clientNotes?.trim() || null) === (intent.clientNotes?.trim() || null) &&
    Number.isFinite(existingStart) &&
    existingStart === requestedStart &&
    (intent.requestedStaffId === BOOKING_ANY_STAFF_ID ||
      existing.staffId === intent.requestedStaffId) &&
    (intent.requestedResourceId == null ||
      existing.resourceId === intent.requestedResourceId) &&
    sameUuidSet(existing.addonServiceIds, intent.addonServiceIds)
  );
}
