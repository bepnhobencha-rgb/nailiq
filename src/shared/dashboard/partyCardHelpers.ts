/**
 * Pure Party Card helpers — no "use server", no DB calls.
 * Shared by loadPartyCardsAction (server) and unit tests.
 */

import { formatInSalonTz } from "@/shared/lib/salonTime";
import type { GroupSyncMode } from "@/shared/booking/loadGroupSmartSchedule";

// ─── Public types ────────────────────────────────────────────────

export type PartyCardSlot = {
  /** UUID of the party_link_claims row. */
  claimId: string;
  /** UUID of the bookings row. */
  bookingId: string;
  /** Name entered by the guest when claiming — null if unclaimed. */
  memberName: string | null;
  /**
   * Booking-level placeholder name from bookings.client_name.
   * For voice bookings this is "Guest 1", "Guest 2", etc.
   * Use this as the display label when memberName is null (unclaimed).
   */
  guestLabel: string;
  serviceName: string;
  staffName: string;
  /** Salon-local display time, e.g. "9:30 AM". */
  startDisplay: string;
  endDisplay: string;
  /** ISO UTC start (for sorting / expiry math). */
  startUtcIso: string;
  claimed: boolean;
};

export type PartyCard = {
  partyLinkId: string;
  groupId: string;
  /** Opaque token — use to construct /party/<token> URL. */
  token: string;
  mode: GroupSyncMode;
  /** true when the party link's 24-hour window has passed. */
  expired: boolean;
  /** Salon-local date label, e.g. "Saturday, May 30". */
  groupDateDisplay: string;
  groupStartDisplay: string;
  groupEndDisplay: string;
  /** ISO UTC for client-side sorting / relative-time display. */
  groupStartUtcIso: string;
  totalSlots: number;
  claimedCount: number;
  pendingCount: number;
  /**
   * Sum of price_cents for all slots.
   * null when ANY slot has a missing price (prevents false revenue display).
   */
  estimatedRevenueCents: number | null;
  slots: PartyCardSlot[];
  /** Number of pending change requests from guests (Part F). 0 when none. */
  pendingChangeRequestCount: number;
};

export type RawClaim = {
  id: string;
  party_link_id: string;
  booking_id: string;
  member_name: string | null;
  claimed_at: string | null;
  bookings: {
    start_time_utc: string | null;
    end_time_utc: string | null;
    price_cents: number | null;
    /** Placeholder name stored on the booking row (e.g. "Guest 3" for voice bookings). */
    client_name: string | null;
    services: { name: string } | null;
    staff: { name: string } | null;
  } | null;
};

export type RawPartyLink = {
  id: string;
  group_id: string;
  token: string;
  mode: string;
  expires_at: string;
};

// ─── Date window ─────────────────────────────────────────────────

/** today midnight UTC → +8 days (covers all of day 7 in any timezone). */
export function partyCardWindowUtc(): { start: Date; end: Date } {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 8 * 24 * 60 * 60 * 1_000);
  return { start, end };
}

// ─── Card builder ─────────────────────────────────────────────────

/**
 * Builds a PartyCard from a set of claims that all belong to the same link.
 * Pure function — no DB calls, safe to unit-test.
 * Deliberately excludes member_phone (not present in RawClaim).
 */
export function buildPartyCard(
  partyLink: RawPartyLink,
  claims: RawClaim[],
  tz: string,
  now: Date,
  pendingChangeRequestCount = 0,
): PartyCard {
  const expired = new Date(partyLink.expires_at) < now;

  const sorted = [...claims].sort((a, b) => {
    const at = a.bookings?.start_time_utc ?? "";
    const bt = b.bookings?.start_time_utc ?? "";
    return at.localeCompare(bt);
  });

  let allPricesKnown = true;
  let totalRevenueCents = 0;
  const startIsos: string[] = [];
  const endIsos: string[] = [];

  const slots: PartyCardSlot[] = sorted.map((c, idx) => {
    const b = c.bookings;
    const startIso = b?.start_time_utc ?? "";
    const endIso = b?.end_time_utc ?? "";

    if (startIso) startIsos.push(startIso);
    if (endIso) endIsos.push(endIso);

    if (b?.price_cents != null) {
      totalRevenueCents += b.price_cents;
    } else {
      allPricesKnown = false;
    }

    return {
      claimId: c.id,
      bookingId: c.booking_id,
      memberName: c.member_name ?? null,
      // Use the DB value (e.g. "Guest 3" for voice bookings) so the label
      // matches exactly what was assigned, regardless of sort order.
      guestLabel: b?.client_name?.trim() || `Guest ${idx + 1}`,
      serviceName: b?.services?.name ?? "—",
      staffName: b?.staff?.name ?? "—",
      startDisplay: startIso ? formatInSalonTz(startIso, tz, "shortTime") : "—",
      endDisplay: endIso ? formatInSalonTz(endIso, tz, "shortTime") : "—",
      startUtcIso: startIso,
      claimed: c.claimed_at !== null,
    };
  });

  const groupStartIso = startIsos.length > 0
    ? startIsos.reduce((a, b) => (a < b ? a : b))
    : "";
  const groupEndIso = endIsos.reduce((a, b) => (a > b ? a : b), "");

  return {
    partyLinkId: partyLink.id,
    groupId: partyLink.group_id,
    token: partyLink.token,
    mode: partyLink.mode as GroupSyncMode,
    expired,
    groupDateDisplay: groupStartIso
      ? formatInSalonTz(groupStartIso, tz, "date")
      : "",
    groupStartDisplay: groupStartIso
      ? formatInSalonTz(groupStartIso, tz, "shortTime")
      : "—",
    groupEndDisplay: groupEndIso
      ? formatInSalonTz(groupEndIso, tz, "shortTime")
      : "—",
    groupStartUtcIso: groupStartIso,
    totalSlots: slots.length,
    claimedCount: slots.filter((s) => s.claimed).length,
    pendingCount: slots.filter((s) => !s.claimed).length,
    estimatedRevenueCents:
      allPricesKnown && slots.length > 0 ? totalRevenueCents : null,
    slots,
    pendingChangeRequestCount,
  };
}
