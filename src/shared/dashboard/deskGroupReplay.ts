import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import {
  parseGroupBookingPricingQuote,
  type GroupBookingPricingQuote,
} from "@/shared/booking/groupBookingPricing";
import { createGroupBookingsAuthoritative } from "@/shared/booking/groupBookingPricingServer";
import type { GroupBookingMember } from "@/shared/booking/submitGroupBooking";
import { isDeskBookingRequestId } from "@/shared/dashboard/deskBookingIdempotency";

export type PersistedGroupMember = {
  id: string;
  status: string;
  groupId: string;
  serviceId: string;
  staffId: string;
  clientName: string;
  clientPhone: string | null;
  clientEmail: string | null;
  clientNotes: string | null;
  startTimeUtc: string;
  endTimeUtc: string;
  staffRequestedByClient: boolean;
  waveNumber: number;
  seatTogether: boolean;
  clientLocale: "en" | "vi" | null;
  resourceId: string | null;
  addonServiceIds: string[];
};

export type DeskGroupReplayIntent = {
  salonId: string;
  members: GroupBookingMember[];
  seatTogether: boolean;
  language: "en" | "vi" | null;
  idempotencyKey: string;
};

export type DeskGroupReplayResult =
  | { kind: "none" }
  | { kind: "conflict" }
  | {
      kind: "replayed";
      groupId: string;
      bookingIds: string[];
      pricing: GroupBookingPricingQuote;
    }
  | { kind: "unavailable" };

function localDateAndTime(utcIso: string, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utcIso));
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    return {
      date: `${value("year")}-${value("month")}-${value("day")}`,
      time: `${value("hour")}:${value("minute")}`,
    };
  } catch {
    return null;
  }
}

function sameOrderedIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameIdSet(left: readonly string[], right: readonly string[]) {
  const a = [...left].sort();
  const b = [...right].sort();
  return sameOrderedIds(a, b);
}

/** Bind a client retry to every original desk-group fact before using the
 * persisted canonical request for a response-loss replay. */
export function deskGroupReplayMatchesIntent(
  persisted: readonly PersistedGroupMember[],
  intent: DeskGroupReplayIntent,
  timezone: string,
): boolean {
  if (persisted.length !== intent.members.length || persisted.length < 2) return false;
  return persisted.every((row, index) => {
    const requested = intent.members[index];
    const local = localDateAndTime(row.startTimeUtc, timezone);
    const phone = validateGuestPhone(requested.phone);
    const expectedPhone = phone.ok ? phone.digits : null;
    const requestedAddonIds = requested.addonServiceIds ?? [];
    return (
      row.status === "confirmed" &&
      row.serviceId === requested.serviceId &&
      row.staffId === requested.staffId &&
      row.clientName === (requested.name.trim() || `Guest ${index + 1}`) &&
      row.clientPhone === expectedPhone &&
      row.clientEmail === (requested.email?.trim().toLowerCase() || null) &&
      row.clientNotes === (requested.notes?.trim() || null) &&
      row.staffRequestedByClient === (requested.staffRequestedByClient ?? true) &&
      row.waveNumber === (requested.waveNumber ?? 1) &&
      row.seatTogether === intent.seatTogether &&
      row.clientLocale === intent.language &&
      row.resourceId === null &&
      local?.date === requested.date &&
      local.time === requested.time &&
      sameOrderedIds(row.addonServiceIds, requestedAddonIds)
    );
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Replay an already-committed normal desk group before any fresh quote,
 * capability, cap, or availability work. The database performs the final exact
 * request-fingerprint comparison under the idempotency advisory lock. */
export async function replayCommittedDeskGroup(
  intent: DeskGroupReplayIntent,
): Promise<DeskGroupReplayResult> {
  if (!isDeskBookingRequestId(intent.idempotencyKey)) return { kind: "conflict" };
  const db = createServiceRoleClient();
  const { data: organizerRaw, error: organizerError } = await db
    .from("bookings" as never)
    .select("id, group_id, public_booking_pricing_snapshot" as never)
    .eq("salon_id" as never, intent.salonId)
    .eq("idempotency_key" as never, intent.idempotencyKey)
    .eq("is_group_organizer" as never, true)
    .maybeSingle();
  if (organizerError) return { kind: "unavailable" };
  if (!organizerRaw) return { kind: "none" };
  const organizer = organizerRaw as unknown as Record<string, unknown>;
  const snapshot = organizer.public_booking_pricing_snapshot;
  const pricing = parseGroupBookingPricingQuote(snapshot, { voucherCode: null });
  if (!pricing || !record(snapshot)) return { kind: "conflict" };
  const groupId = typeof snapshot.group_id === "string" ? snapshot.group_id : "";
  const bookingIds = Array.isArray(snapshot.booking_ids)
    ? snapshot.booking_ids.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (
    !groupId ||
    organizer.group_id !== groupId ||
    bookingIds.length !== intent.members.length ||
    pricing.groupSize !== bookingIds.length
  ) return { kind: "conflict" };

  const [{ data: salonRaw, error: salonError }, { data: rowsRaw, error: rowsError }] =
    await Promise.all([
      db.from("salons" as never)
        .select("timezone" as never)
        .eq("id" as never, intent.salonId)
        .maybeSingle(),
      db.from("bookings" as never)
        .select(
          "id, status, group_id, service_id, staff_id, client_name, client_phone, client_email, client_notes, start_time_utc, end_time_utc, staff_requested_by_client, wave_number, seat_together, client_locale, resource_id, booking_addons(service_id)" as never,
        )
        .eq("salon_id" as never, intent.salonId)
        .in("id" as never, bookingIds),
    ]);
  if (salonError || rowsError || !salonRaw || !Array.isArray(rowsRaw)) {
    return { kind: "unavailable" };
  }
  const timezone = String((salonRaw as unknown as { timezone?: unknown }).timezone ?? "");
  if (!timezone) return { kind: "unavailable" };
  const byId = new Map(
    (rowsRaw as unknown as Array<Record<string, unknown>>).map((row) => [String(row.id), row]),
  );
  const persisted: PersistedGroupMember[] = [];
  for (const bookingId of bookingIds) {
    const row = byId.get(bookingId);
    if (!row || row.group_id !== groupId) return { kind: "conflict" };
    const storedAddons = Array.isArray(row.booking_addons)
      ? row.booking_addons
          .map((addon) => record(addon) && typeof addon.service_id === "string" ? addon.service_id : "")
          .filter(Boolean)
      : [];
    const quoteMember = pricing.memberQuotes[persisted.length];
    if (!quoteMember || !sameIdSet(storedAddons, quoteMember.addonServiceIds)) {
      return { kind: "conflict" };
    }
    persisted.push({
      id: bookingId,
      status: String(row.status ?? ""),
      groupId,
      serviceId: String(row.service_id ?? ""),
      staffId: String(row.staff_id ?? ""),
      clientName: String(row.client_name ?? ""),
      clientPhone: typeof row.client_phone === "string" ? row.client_phone : null,
      clientEmail: typeof row.client_email === "string" ? row.client_email.toLowerCase() : null,
      clientNotes: typeof row.client_notes === "string" ? row.client_notes : null,
      startTimeUtc: String(row.start_time_utc ?? ""),
      endTimeUtc: String(row.end_time_utc ?? ""),
      staffRequestedByClient: row.staff_requested_by_client === true,
      waveNumber: Number(row.wave_number ?? 1),
      seatTogether: row.seat_together === true,
      clientLocale: row.client_locale === "en" || row.client_locale === "vi" ? row.client_locale : null,
      resourceId: typeof row.resource_id === "string" ? row.resource_id : null,
      // Preserve the request order captured in the authoritative snapshot;
      // nested relation rows have no stable ordering.
      addonServiceIds: quoteMember.addonServiceIds,
    });
  }
  if (!deskGroupReplayMatchesIntent(persisted, intent, timezone)) {
    return { kind: "conflict" };
  }

  const created = await createGroupBookingsAuthoritative({
    salonId: intent.salonId,
    bookings: persisted.map((row) => ({
      serviceId: row.serviceId,
      staffId: row.staffId,
      startTimeUtc: row.startTimeUtc,
      endTimeUtc: row.endTimeUtc,
      addonServiceIds: row.addonServiceIds,
      clientName: row.clientName,
      clientPhone: row.clientPhone,
      clientEmail: row.clientEmail,
      clientNotes: row.clientNotes,
      staffRequestedByClient: row.staffRequestedByClient,
      waveNumber: row.waveNumber,
      seatTogether: row.seatTogether,
      clientLocale: row.clientLocale,
      resourceId: row.resourceId,
    })),
    voucherCode: null,
    applyEmailDiscount: false,
    idempotencyKey: intent.idempotencyKey,
    expectedPricingFingerprint: pricing.pricingFingerprint,
  });
  if (!created.ok) {
    return created.code === "idempotency_conflict"
      ? { kind: "conflict" }
      : { kind: "unavailable" };
  }
  if (!created.idempotent || created.groupId !== groupId || !sameOrderedIds(created.bookingIds, bookingIds)) {
    return { kind: "conflict" };
  }
  return { kind: "replayed", groupId, bookingIds, pricing: created.pricing };
}
