"use server";

/**
 * Party Link server actions.
 *
 * Party Links let group booking organisers share a URL with their party.
 * Each member opens /party/<token>, sees their slot, and claims it by
 * entering their name + phone.
 *
 * Security contract:
 *   - Phone numbers are NEVER returned to anonymous callers. loadPartyLinkPage
 *     explicitly excludes the member_phone column.
 *   - Claiming is atomic via the claim_party_slot SECURITY DEFINER RPC so the
 *     application-level check (not already claimed, token not expired) cannot
 *     race.
 *   - createPartyLink validates that every booking_id genuinely belongs to
 *     group_id before inserting, preventing link forgery.
 *   - Service-role client is used for all writes (no anon INSERT policy).
 */

import crypto from "crypto";
import * as Sentry from "@sentry/nextjs";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { formatInSalonTz } from "@/shared/lib/salonTime";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";
import type { GroupSyncMode } from "@/shared/booking/loadGroupSmartSchedule";

// ─── Constants ────────────────────────────────────────────────────

/** Token length in random bytes → 16 hex chars (well above the 8-char minimum). */
const TOKEN_BYTES = 8;
/** Party link is valid for 24 hours after the first group member's start time. */
const PARTY_LINK_TTL_MS = 24 * 60 * 60 * 1_000;
/** Maximum claim attempts per call (not a limit for users — limits DB retry loops). */
const TOKEN_COLLISION_RETRIES = 5;

// ─── Public types ─────────────────────────────────────────────────

export type PartyLinkSlot = {
  /** UUID of the party_link_claims row — used as claimId in claimPartySlot. */
  claimId: string;
  /** booking_id the slot refers to. */
  bookingId: string;
  serviceName: string;
  staffName: string;
  /** Salon-local wall-time display, e.g. "9:30 AM". */
  startDisplay: string;
  endDisplay: string;
  /** ISO UTC start (for sorting + ICS generation). */
  startUtcIso: string;
  /** ISO UTC end (for ICS generation). */
  endUtcIso: string;
  /** true if this slot has already been claimed by someone. */
  claimed: boolean;
  /** Name of the person who claimed it, or null if unclaimed. */
  claimedByName: string | null;
  /**
   * Booking-level placeholder name from bookings.client_name.
   * For voice group bookings this is "Guest 1", "Guest 2", etc.
   * Shown on unclaimed slots so the party link displays the group roster
   * before anyone claims.  Replaced by claimedByName once claimed.
   */
  guestLabel: string;
  /** Which wave this slot belongs to (Phase 6). 1 for normal group bookings;
   *  2, 3 … for later waves of a large group split across time. */
  waveNumber: number;
};

export type PartyLinkPageData = {
  token: string;
  /** Salon UUID — used by the claim form's returning-customer lookup. */
  salonId: string;
  salonName: string;
  /** Salon-local date, e.g. "Saturday, June 15, 2030". */
  groupDateDisplay: string;
  /** Earliest start across all slots — salon-local wall-time. */
  groupStartDisplay: string;
  /** Latest end across all slots — salon-local wall-time. */
  groupEndDisplay: string;
  mode: GroupSyncMode;
  slots: PartyLinkSlot[];
  expired: boolean;
  /** Phase 6.2 — resolved per-salon config with safe defaults. */
  partyConfig: {
    showGroupProgress: boolean;
    showAddToCalendar: boolean;
    showPrivacyNote: boolean;
    showArrivalNote: boolean;
    requirePhone: boolean;
  };
};

export type CreatePartyLinkResult =
  | { ok: true; token: string; url: string }
  | { ok: false; reason: string };

export type ClaimPartySlotResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "already_claimed" | "invalid_input" | "server_error" };

export type EditPartyClaimResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "not_claimed" | "invalid_input" | "server_error" };

export type SubmitPartyChangeResult =
  | { ok: true; changeRequestId: string }
  | { ok: false; reason: "not_found" | "expired" | "not_claimed" | "invalid_input" | "server_error" };

export type PartyChangeRequestType = "service_change" | "staff_preference" | "note";

// ─── createPartyLink ─────────────────────────────────────────────

/**
 * Called by BookingGroupFlow immediately after a successful group
 * booking to generate the shareable party link.
 *
 * Validates that every bookingId genuinely belongs to groupId (prevents
 * link forgery via a crafted server action call).  Pre-creates one
 * party_link_claims row per booking so each slot has a stable id.
 */
export async function createPartyLink(params: {
  groupId: string;
  salonId: string;
  bookingIds: string[];
  mode: GroupSyncMode;
  /** UTC ISO of the earliest group member start time — used to compute expiry. */
  groupStartUtcIso: string;
  /** Base URL of the deployment, e.g. "https://nailiq.ca". */
  baseUrl: string;
  /** Name of the person who organised the group booking (optional). */
  organizerName?: string;
  /** Normalised phone digits of the organiser (optional). */
  organizerPhone?: string;
  /** Booking id of the organiser's OWN slot, when the organiser is also
   *  one of the guests. That slot is pre-claimed (they already booked),
   *  so the share link never asks the organiser to claim themselves.
   *  Null/undefined when the organiser is only the contact (booking on
   *  behalf of others) — then every slot is claimable. */
  organizerBookingId?: string | null;
  /** Booking-surface language so the shared link opens in the same language
   *  (the /party page otherwise defaults to English / Accept-Language). */
  language?: "en" | "vi";
}): Promise<CreatePartyLinkResult> {
  const { groupId, salonId, bookingIds, mode, groupStartUtcIso, baseUrl, organizerName, organizerPhone, organizerBookingId, language } = params;
  const langQuery = language === "en" || language === "vi" ? `?lang=${language}` : "";

  if (!groupId || !salonId || !Array.isArray(bookingIds) || bookingIds.length < 2) {
    return { ok: false, reason: "invalid_input" };
  }

  let db: ReturnType<typeof createServiceRoleClient>;
  try {
    db = createServiceRoleClient();
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[nailiq] createPartyLink: service-role client unavailable — Party Link will NOT be created.\n" +
          "  The booking success screen still works; only the share box is missing.\n" +
          "  Set SUPABASE_SERVICE_ROLE_KEY in .env.local for end-to-end local testing.",
      );
    }
    Sentry.captureException(err, { extra: { groupId } });
    return { ok: false, reason: "server_error" };
  }

  // Validate: all booking_ids exist, have the correct group_id and salon_id.
  const { data: rows, error: verifyErr } = await db
    .from("bookings")
    .select("id, group_id, salon_id, start_time_utc, end_time_utc, service_id, staff_id")
    .in("id", bookingIds)
    .eq("group_id", groupId)
    .eq("salon_id", salonId);

  if (verifyErr || !rows || rows.length !== bookingIds.length) {
    Sentry.captureMessage("createPartyLink: booking validation failed", {
      level: "warning",
      extra: { groupId, salonId, bookingIds, verifyErr },
    });
    return { ok: false, reason: "validation_failed" };
  }

  // Compute expiry: earliest start + 24 h.
  const startMs = rows.reduce((min, r) => {
    const ms = r.start_time_utc ? new Date(r.start_time_utc).getTime() : Infinity;
    return ms < min ? ms : min;
  }, Infinity);
  const expiresAt = new Date(
    isFinite(startMs) ? startMs + PARTY_LINK_TTL_MS : Date.now() + PARTY_LINK_TTL_MS,
  ).toISOString();

  // Generate a unique token (retry on collision).
  let token: string | null = null;
  let linkId: string | null = null;

  for (let attempt = 0; attempt < TOKEN_COLLISION_RETRIES; attempt++) {
    const candidate = crypto.randomBytes(TOKEN_BYTES).toString("hex"); // 16 hex chars

    const { data: link, error: insertErr } = await db
      .from("party_links")
      .insert({
        group_id:        groupId,
        salon_id:        salonId,
        token:           candidate,
        mode,
        expires_at:      expiresAt,
        organizer_name:  organizerName?.trim() || null,
        organizer_phone: organizerPhone?.trim() || null,
      })
      .select("id")
      .single();

    if (insertErr) {
      // Unique violation on token → retry.
      if (insertErr.code === "23505" && insertErr.message.includes("token")) continue;
      // Unique violation on group_id → party link already exists, return it.
      if (insertErr.code === "23505" && insertErr.message.includes("group_id")) {
        const { data: existing } = await db
          .from("party_links")
          .select("id, token")
          .eq("group_id", groupId)
          .single();
        if (existing) {
          return { ok: true, token: existing.token, url: `${baseUrl}/party/${existing.token}${langQuery}` };
        }
      }
      Sentry.captureException(insertErr, { extra: { groupId, attempt } });
      return { ok: false, reason: "server_error" };
    }

    token = candidate;
    linkId = link.id;
    break;
  }

  if (!token || !linkId) {
    return { ok: false, reason: "token_collision" };
  }

  // Pre-create one claim per booking (unclaimed = member_name NULL,
  // claimed_at NULL). The organiser's own slot is pre-claimed with their
  // name + phone so the share link shows it confirmed and never asks the
  // person who booked to claim themselves.
  const claimRows = bookingIds.map((bid) => {
    const isOrganizer =
      organizerBookingId != null && bid === organizerBookingId;
    if (isOrganizer) {
      return {
        party_link_id: linkId as string,
        booking_id: bid,
        member_name: organizerName?.trim() || null,
        member_phone: toCanonicalPhone(organizerPhone),
        claimed_at: new Date().toISOString(),
      };
    }
    return {
      party_link_id: linkId as string,
      booking_id: bid,
    };
  });

  const { error: claimErr } = await db.from("party_link_claims").insert(claimRows);
  if (claimErr) {
    Sentry.captureException(claimErr, { extra: { groupId, linkId } });
    // Non-fatal: the link is created; claims can be lazy-created later.
    // But return ok so the user gets the URL.
  }

  return { ok: true, token, url: `${baseUrl}/party/${token}${langQuery}` };
}

// ─── loadPartyLinkPage ────────────────────────────────────────────

/**
 * Safe public read for the /party/[token] server component.
 * Never returns member_phone.
 */
export async function loadPartyLinkPage(
  token: string,
): Promise<PartyLinkPageData | null> {
  if (!token || token.length < 8) return null;

  let db: ReturnType<typeof createServiceRoleClient>;
  try {
    db = createServiceRoleClient();
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[nailiq] loadPartyLinkPage: service-role client unavailable — /party/[token] will show 404.\n" +
          "  Set SUPABASE_SERVICE_ROLE_KEY in .env.local for end-to-end local testing.",
      );
    }
    Sentry.captureException(err);
    return null;
  }

  const { data: link, error: linkErr } = await db
    .from("party_links")
    .select(
      `
      id,
      group_id,
      salon_id,
      mode,
      expires_at,
      salons (
        name,
        timezone,
        party_config
      )
    `,
    )
    .eq("token", token)
    .single();

  if (linkErr || !link) return null;

  const salon = link.salons as unknown as {
    name: string;
    timezone: string;
    party_config: Record<string, unknown> | null;
  } | null;
  if (!salon) return null;

  const expired = new Date(link.expires_at) < new Date();

  // Load claims with booking details — intentionally excludes member_phone.
  const { data: claims, error: claimsErr } = await db
    .from("party_link_claims")
    .select(
      `
      id,
      booking_id,
      member_name,
      claimed_at,
      bookings (
        start_time_utc,
        end_time_utc,
        client_name,
        wave_number,
        services!bookings_service_id_fkey ( name ),
        staff!bookings_staff_id_fkey ( name )
      )
    `,
    )
    .eq("party_link_id", link.id)
    .order("created_at");

  if (claimsErr || !claims) return null;

  // Build slot objects — safe, no phone exposure.
  const tz = salon.timezone || "UTC";
  const slots: PartyLinkSlot[] = claims.map((c, i) => {
    const booking = c.bookings as unknown as {
      start_time_utc: string | null;
      end_time_utc: string | null;
      client_name: string | null;
      wave_number: number | null;
      services: { name: string } | null;
      staff: { name: string } | null;
    } | null;

    const startIso = booking?.start_time_utc ?? "";
    const endIso = booking?.end_time_utc ?? "";

    return {
      claimId: c.id,
      bookingId: c.booking_id,
      serviceName: booking?.services?.name ?? "—",
      staffName: booking?.staff?.name ?? "—",
      startDisplay: startIso ? formatInSalonTz(startIso, tz, "shortTime") : "—",
      endDisplay: endIso ? formatInSalonTz(endIso, tz, "shortTime") : "—",
      startUtcIso: startIso,
      endUtcIso: endIso,
      claimed: c.claimed_at !== null,
      claimedByName: c.member_name ?? null,
      // bookings.client_name is "Guest N" for voice group bookings and the
      // organiser-supplied (or defaulted) name for web group bookings.
      // Falls back to a derived label only when the DB value is missing.
      guestLabel: booking?.client_name?.trim() || `Guest ${i + 1}`,
      waveNumber: booking?.wave_number ?? 1,
    };
  });

  // Sort by start time so the UI renders chronologically.
  slots.sort((a, b) => a.startUtcIso.localeCompare(b.startUtcIso));

  // Group display times: earliest start / latest end.
  const validStarts = slots.map((s) => s.startUtcIso).filter(Boolean);
  const validEnds = claims
    .map((c) => {
      const b = c.bookings as unknown as { end_time_utc: string | null } | null;
      return b?.end_time_utc ?? "";
    })
    .filter(Boolean);

  const groupStartIso = validStarts.length ? validStarts.reduce((a, b) => (a < b ? a : b)) : "";
  const groupEndIso = validEnds.length ? validEnds.reduce((a, b) => (a > b ? a : b)) : "";

  const groupStartDisplay = groupStartIso ? formatInSalonTz(groupStartIso, tz, "shortTime") : "—";
  const groupEndDisplay = groupEndIso ? formatInSalonTz(groupEndIso, tz, "shortTime") : "—";
  const groupDateDisplay = groupStartIso
    ? formatInSalonTz(groupStartIso, tz, "date")
    : "";

  // Resolve party config with safe defaults (no secret data exposed).
  const cfg = salon.party_config ?? {};
  const partyConfig = {
    showGroupProgress:  cfg.show_group_progress  !== false,
    showAddToCalendar:  cfg.show_add_to_calendar !== false,
    showPrivacyNote:    cfg.show_privacy_note    !== false,
    showArrivalNote:    cfg.show_arrival_note    !== false,
    // Phone is OPTIONAL by default — the appointment is already booked when
    // the link is shared; a phone only adds the guest's own SMS reminder.
    // A salon can opt back into requiring it by setting require_phone: true.
    requirePhone:       cfg.require_phone        === true,
  };

  return {
    token,
    salonId: (link as { salon_id?: string }).salon_id ?? "",
    salonName: salon.name,
    groupDateDisplay,
    groupStartDisplay,
    groupEndDisplay,
    mode: link.mode as GroupSyncMode,
    slots,
    expired,
    partyConfig,
  };
}

// ─── claimPartySlot ───────────────────────────────────────────────

/**
 * Called by the PartyClaimClient when a member submits their name + phone.
 * Delegates atomicity to the claim_party_slot SECURITY DEFINER RPC.
 */
export async function claimPartySlot(params: {
  token: string;
  claimId: string;
  memberName: string;
  memberPhone: string;
  reminderOptedIn: boolean;
}): Promise<ClaimPartySlotResult> {
  const { token, claimId, memberName, memberPhone, reminderOptedIn } = params;

  // Input validation — client-side mirrors these but server always re-checks.
  const nameTrim = memberName.trim();
  if (!nameTrim || nameTrim.length > BOOKING_GUEST_NAME_MAX || !isValidCustomerName(nameTrim)) {
    return { ok: false, reason: "invalid_input" };
  }

  // Phone is OPTIONAL — the appointment is already booked. A phone only adds
  // this guest's own SMS reminder. If provided it must be valid; if blank we
  // store null and there's nothing to remind.
  const phoneTrim = memberPhone.trim();
  let phoneDigits: string | null = null;
  if (phoneTrim) {
    const phoneResult = validateGuestPhone(phoneTrim);
    if (!phoneResult.ok) {
      return { ok: false, reason: "invalid_input" };
    }
    phoneDigits = phoneResult.digits;
  }

  const db = createServiceRoleClient();

  const { data, error } = await db.rpc("claim_party_slot", {
    p_token: token,
    p_claim_id: claimId,
    p_member_name: nameTrim,
    p_member_phone: phoneDigits,
    p_reminder_opted_in: reminderOptedIn && phoneDigits != null,
  });

  if (error) {
    Sentry.captureException(error, { extra: { token, claimId } });
    return { ok: false, reason: "server_error" };
  }

  const result = data as Record<string, unknown>;
  if (!result?.success) {
    const code = result?.code as string | undefined;
    if (code === "not_found") return { ok: false, reason: "not_found" };
    if (code === "expired") return { ok: false, reason: "expired" };
    if (code === "already_claimed") return { ok: false, reason: "already_claimed" };
    return { ok: false, reason: "server_error" };
  }

  return { ok: true };
}

// ─── editPartyClaimDetails ────────────────────────────────────────

/**
 * Lets a member update their name, phone, and reminder preference
 * after they have already claimed their slot.
 * Delegates atomicity to the update_party_claim_details SECURITY DEFINER RPC,
 * which also propagates the name change to bookings.client_name.
 */
export async function editPartyClaimDetails(params: {
  token: string;
  claimId: string;
  memberName: string;
  memberPhone: string;
  reminderOptedIn: boolean;
}): Promise<EditPartyClaimResult> {
  const { token, claimId, memberName, memberPhone, reminderOptedIn } = params;

  // Input validation — client-side mirrors these but server always re-checks.
  const nameTrim = memberName.trim();
  if (!nameTrim || nameTrim.length > BOOKING_GUEST_NAME_MAX || !isValidCustomerName(nameTrim)) {
    return { ok: false, reason: "invalid_input" };
  }

  // Phone optional (same contract as claimPartySlot).
  const phoneTrim = memberPhone.trim();
  let phoneDigits: string | null = null;
  if (phoneTrim) {
    const phoneResult = validateGuestPhone(phoneTrim);
    if (!phoneResult.ok) {
      return { ok: false, reason: "invalid_input" };
    }
    phoneDigits = phoneResult.digits;
  }

  const db = createServiceRoleClient();

  const { data, error } = await db.rpc("update_party_claim_details", {
    p_token:             token,
    p_claim_id:          claimId,
    p_member_name:       nameTrim,
    p_member_phone:      phoneDigits,
    p_reminder_opted_in: reminderOptedIn && phoneDigits != null,
  });

  if (error) {
    Sentry.captureException(error, { extra: { token, claimId } });
    return { ok: false, reason: "server_error" };
  }

  const result = data as Record<string, unknown>;
  if (!result?.success) {
    const code = result?.code as string | undefined;
    if (code === "not_found")    return { ok: false, reason: "not_found" };
    if (code === "expired")      return { ok: false, reason: "expired" };
    if (code === "not_claimed")  return { ok: false, reason: "not_claimed" };
    return { ok: false, reason: "server_error" };
  }

  return { ok: true };
}

// ─── submitPartyChangeRequest ─────────────────────────────────────

/**
 * Submits a change request on behalf of a group booking member.
 * The request is queued as 'pending' for salon staff to review.
 *
 * Security contract:
 *   - token must belong to a non-expired party link.
 *   - claimId must belong to that link AND be claimed (only a real
 *     member who confirmed their slot can request a change).
 *   - Phone numbers are NOT collected here; the claim row is the link.
 *   - Service-role client used for all writes.
 */
export async function submitPartyChangeRequest(params: {
  token: string;
  claimId: string;
  bookingId: string;
  requestType: PartyChangeRequestType;
  note?: string;
}): Promise<SubmitPartyChangeResult> {
  const { token, claimId, bookingId, requestType, note } = params;

  if (!token || token.length < 8) return { ok: false, reason: "not_found" };
  if (!claimId || !bookingId)      return { ok: false, reason: "invalid_input" };
  if (!["service_change", "staff_preference", "note"].includes(requestType)) {
    return { ok: false, reason: "invalid_input" };
  }

  const noteTrim = (note ?? "").trim().slice(0, 500);

  let db: ReturnType<typeof createServiceRoleClient>;
  try {
    db = createServiceRoleClient();
  } catch (err) {
    Sentry.captureException(err);
    return { ok: false, reason: "server_error" };
  }

  // Validate token is active and claim belongs to it.
  const { data: link, error: linkErr } = await db
    .from("party_links")
    .select("id, expires_at")
    .eq("token", token)
    .single();

  if (linkErr || !link) return { ok: false, reason: "not_found" };
  if (new Date(link.expires_at) < new Date()) return { ok: false, reason: "expired" };

  const { data: claim, error: claimErr } = await db
    .from("party_link_claims")
    .select("id, claimed_at")
    .eq("id", claimId)
    .eq("party_link_id", link.id)
    .single();

  if (claimErr || !claim) return { ok: false, reason: "not_found" };
  if (!claim.claimed_at)  return { ok: false, reason: "not_claimed" };

  // Insert the change request.
  const { data: inserted, error: insertErr } = await db
    .from("party_link_change_requests")
    .insert({
      party_link_id: link.id,
      booking_id:    bookingId,
      claim_id:      claimId,
      request_type:  requestType,
      note:          noteTrim.length > 0 ? noteTrim : null,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    Sentry.captureException(insertErr ?? new Error("submitPartyChangeRequest: no id returned"), {
      extra: { token, claimId, bookingId, requestType },
    });
    return { ok: false, reason: "server_error" };
  }

  return { ok: true, changeRequestId: inserted.id };
}
