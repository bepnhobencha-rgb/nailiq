import * as Sentry from "@sentry/nextjs";
import {
  ConflictCheckBooking,
  checkBookingConflict,
} from "@/shared/lib/conflictCheck";
import { assertBookingLimitAvailable } from "@/shared/booking/assertBookingLimit";
import { stampGroupBookingIdentity } from "@/shared/booking/groupBookingSideEffects";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import { computeBookingTiming } from "@/shared/booking/bookingTiming";
import { checkGroupWithinOpeningHours } from "@/shared/booking/groupBookingHoursPolicy";
import { evaluateControlledAfterHours } from "@/shared/booking/controlledAfterHours";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import {
  salonDayRangeUtc,
  salonToday,
  salonWallTimeToUtcIso,
} from "@/shared/lib/salonTime";
import { createPublicClient } from "@/shared/lib/supabase/publicClient";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";

/**
 * Group booking submission — 2–4 friends/family booking together.
 *
 * Each member becomes its own `bookings` row, all sharing a `group_id`
 * UUID. Insert is atomic via the `insert_group_bookings` PostgreSQL
 * function (migration 20260512200000) — if member N conflicts, the
 * whole transaction rolls back and the client sees a structured
 * `slot_conflict` with the index list of conflicting members.
 *
 * Reuses (DOES NOT reimplement):
 *   - `salonWallTimeToUtcIso` for date+time → UTC conversion
 *     (DST-safe binary search; handles every salon timezone)
 *   - `checkBookingConflict` for app-level pre-flight check (same
 *     contract as `submitPublicBooking.ts`)
 *   - `bookings_no_overlap` GIST EXCLUDE constraint as DB-level
 *     guard against true races; the RPC translates 23P01 → the
 *     `slot_conflict` error code
 *   - the durable `(salon_id, request_id)` request ledger for exact replay;
 *     a changed payload under the same key fails with
 *     `idempotency_conflict`
 *
 * Out of scope (Phase 2+ tracked in CLAUDE.md):
 *   - Splitting a group into individuals post-confirm
 *   - Merging individuals into a group
 *   - Walk-in queue integration
 *   - Editing one member's slot after the group is confirmed
 *     (individual edit still works via the existing single-booking
 *     edit path; that's not part of this action)
 */

export type GroupBookingMember = {
  name: string;
  phone: string;
  email?: string | null;
  notes?: string | null;
  serviceId: string;
  /** UUID or the "any" sentinel — Phase 1 requires explicit staff for
   * each member so cross-member conflict detection is deterministic.
   * If the spec ever supports "any" inside a group, the picker must
   * run server-side after the per-member checks. */
  staffId: string;
  /** YYYY-MM-DD in salon-local time (not UTC). */
  date: string;
  /** HH:MM (24h) in salon-local time. */
  time: string;
  /** Phase 6.1 — wave this member belongs to (1 for normal bookings). */
  waveNumber?: number;
  /** Add-on service IDs selected for this member. The group insert RPC
   *  validates, de-duplicates and itemizes them in the same transaction as
   *  every booking row. Sequential add-ons extend the end time; concurrent
   *  add-ons add price but +0 time. Prices/durations are re-derived
   *  server-side from the database. */
  addonServiceIds?: string[];
};

export type GroupBookingParams = {
  shopSlug: string;
  members: GroupBookingMember[];
  /** Client-generated UUID (crypto.randomUUID()). Every member in this one
   * request carries the same key. An exact retry returns the original atomic
   * result; reusing the key with a changed payload fails closed. */
  idempotencyKey: string;
  /** Short-lived, request-scoped proof used only to authorize the matching
   * owner-notification handoff after this atomic write. The database stores
   * SHA-256 only and binds it to this request's canonical organizer booking. */
  notificationCapability?: string | null;
  /** Task #09-11 honeypot. Optional; matches the public booking
   *  contract. UI plumbing in `BookingGroupFlow.tsx` is TODO —
   *  accepting the field now means a future hidden input there can
   *  ship as a UI-only change. Empty / unset = pass-through to the
   *  real flow. */
  clientWebsite?: string;
  /** Group/couple wants to be seated next to each other (head-spa
   *  curtain "couple" space, or friends sitting together). Persisted
   *  on every member row inside the `insert_group_bookings` RPC so the
   *  receptionist board can show a 💕 badge. Default false. */
  seatTogether?: boolean;
  /** Language the organizer booked in ("en"|"vi") — the confirmation SMS to
   *  the primary contact matches it. Absent → falls back to stored pref / vi. */
  language?: "en" | "vi";
  /** OTP session UUID (from /api/booking-otp/verify on the organizer's phone).
   *  Required when the salon has phone_otp_enabled — the same artifact the
   *  individual flow uses. Blocks fake-number group bookings (sabotage). */
  otpSessionId?: string | null;
  /** Voucher applied to the WHOLE party total, tied to the organizer's phone
   *  (mirrors submitPublicBooking). Redeemed against the lead booking after the
   *  group is created. Absent → no discount. */
  voucherRedemption?: { voucher_id: string; discount_cents: number } | null;
  /** The organizer ticked the required SMS-consent box in their browser. The
   *  desk path (`receptionistActions.createDeskGroup`) calls this server-side
   *  with no checkbox on screen, so it leaves this unset — otherwise we would
   *  write a consent record stamped with the server's own IP. */
  smsConsent?: boolean;
  /** Which channel created this party: 'online' (public group wizard) or
   *  'desk' (receptionist). Stamped on every member row so reports can group
   *  by origin. Before this existed the whole group path wrote NULL, and
   *  `loadSalonReports` folds NULL into "online" — so desk-created
   *  parties were silently counted as online bookings rather than going
   *  missing. Defaults to 'online' so the public flow stays correct even if a
   *  caller forgets to pass it. */
  bookingChannel?: "online" | "desk";
};

export type GroupBookingResult =
  | {
      ok: true;
      groupId: string;
      bookingIds: string[];
      /** True when the durable ledger returned an already-committed party. */
      idempotentReplay?: boolean;
    }
  | {
      ok: false;
      reason: "slot_conflict";
      conflictingMembers: number[];
      /** P1.6 — distinguishes "two members in this group collided
       * with each other" from "another customer just took that
       * slot". UI copy differs: cross-member asks the user to pick
       * a different staff/time within the group, external blames
       * the race and asks for a different time entirely. The DB-
       * level race always surfaces as `external` because we can't
       * attribute the lost slot to a specific in-group pair. */
      conflictKind: "cross_member" | "external";
    }
  | {
      ok: false;
      reason:
        | "duplicate_submission"
        | "salon_paused"
        | "salon_not_found"
        // Organizer phone not OTP-verified (salon has phone_otp_enabled).
        | "otp_required"
        | "otp_invalid"
        // PR3 — release flag `group_booking` is OFF for this salon.
        // Defense-in-depth: PR2 already hides the group UI, but a direct
        // server-action call must still be refused.
        | "feature_not_enabled"
        | "salon_closed_day"
        | "invalid_input"
        | "invalid_group_size"
        // Task #04-C — `service_not_found` / `staff_not_found` are
        // retained for backward-compat with any external caller
        // that may already pattern-match on them. New code paths
        // (Task #04-C FIX 12 / FIX 13) prefer the more specific
        // `_unavailable` reasons below, which carry `memberIndex`
        // so the UI can recover (auto re-run scheduler for staff,
        // navigate to step 2 with highlight for service).
        | "service_not_found"
        | "staff_not_found"
        | "past_date"
        | "server_error"
        // P1 #18–#20 (QA re-sweep 2026-05-12) — granular validation
        // reasons so the UI can show "phone format wrong" / "email
        // format wrong" etc. instead of the catch-all
        // "couldn't book". Each maps 1:1 onto a copy key in
        // `groupBooking.bookingErrors.*`. `invalid_input` is kept as
        // a defensive fallback for inputs that fail before per-member
        // validation (idempotency key, members array shape).
        | "invalid_name"
        | "invalid_phone"
        | "invalid_email"
        | "invalid_time"
        | "invalid_date"
        | "invalid_addons"
        | "too_many_addons"
        | "idempotency_conflict"
        // Task #04-C FIX 12 — staff was deleted / inactivated
        // between the user picking an arrangement and submitting.
        // Recoverable by re-running the scheduler.
        | "staff_unavailable"
        // Task #04-C FIX 13 — service was soft-deleted between
        // step 2 and submit. Recoverable only by sending the user
        // back to step 2 to pick a different service.
        | "service_unavailable"
        | "after_hours_not_allowed"
        | "specific_staff_required"
        | "staff_consent_required"
        | "after_hours_limit_exceeded"
        | "outside_hours"
        | "invalid_after_hours_override"
        // Salon's plan-tier monthly booking cap would be exceeded by
        // this group submit. Recoverable only by the salon owner
        // upgrading the plan.
        | "monthly_booking_limit_reached";
      /** 1-indexed member number for granular per-member errors so
       *  the UI can say "Person 2 has an invalid phone". `null` when
       *  the error is global (e.g. invalid group size). */
      memberNumber?: number | null;
      /** 0-indexed member position — same as `memberNumber - 1`,
       *  surfaced specifically for `staff_unavailable` /
       *  `service_unavailable` where the UI needs to operate on the
       *  member array (highlight a card / pre-select a member for
       *  re-pick). */
      memberIndex?: number | null;
    };

/**
 * Server-only escape hatch used by the authenticated front-desk action.
 *
 * This is intentionally NOT part of GroupBookingParams: public, Voice and SMS
 * callers can only reach the normal `insert_group_bookings` boundary, which
 * rejects out-of-hours rows. The desk action supplies a privileged writer only
 * after proving Owner/Admin, an attributable auth user and staff consent.
 */
export type TrustedGroupBookingExecution = {
  controlledAfterHours: {
    actorUserId: string;
    staffConsentConfirmed: true;
  };
  insertGroupBookings: (payload: Array<Record<string, unknown>>) => Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
};

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseHmToMinutes(hm: string): number | null {
  const m = HHMM_RE.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function fail(
  reason: Exclude<
    Extract<GroupBookingResult, { ok: false }>["reason"],
    "slot_conflict"
  >,
  memberNumber: number | null = null,
): GroupBookingResult {
  // Structured failures never throw, so without this they're invisible to
  // error_logs/Sentry — inherits the booking.flow/salon.slug tags set on the
  // scope at the top of submitGroupBooking.
  Sentry.captureMessage(`group booking rejected: ${reason}`, {
    level: "warning",
    tags: { "booking.fail_reason": reason },
    extra: { memberNumber },
  });
  return { ok: false, reason, memberNumber };
}

export async function submitGroupBooking(
  params: GroupBookingParams,
  trustedExecution?: TrustedGroupBookingExecution,
): Promise<GroupBookingResult> {
  const scope = Sentry.getCurrentScope();
  scope.setTag("booking.flow", "submit_group_booking");
  scope.setTag("salon.slug", params.shopSlug);

  // Task #09-11 — honeypot guard. Mirrors `submitPublicBooking`.
  // `BookingGroupFlow.tsx` does not yet render a hidden input that
  // sets this field, so today the branch never fires from the real
  // UI — accepting the field positions the server side to short-
  // circuit silently as soon as the UI plumbing lands.
  if ((params.clientWebsite ?? "").trim().length > 0) {
    Sentry.captureMessage("group booking honeypot tripped", {
      level: "info",
      tags: {
        "booking.flow": "submit_group_booking",
        "booking.honeypot": "tripped",
        "salon.slug": params.shopSlug,
      },
    });
    return {
      ok: true,
      groupId: `bot-${Date.now()}`,
      bookingIds: [],
    };
  }

  // 1. Surface-level validation -------------------------------------
  // Dynamic capacity: cap raised to GROUP_MAX_SIZE (20) to match the
  // DB RPC and the UI formula `Math.min(activeStaffCount, 20)`. The
  // effective limit is still the salon's active-staff count, enforced
  // by the scheduler; this check is just an absolute safety fence.
  if (
    !Array.isArray(params.members) ||
    params.members.length < 2 ||
    params.members.length > 20
  ) {
    return fail("invalid_group_size");
  }
  if (
    typeof params.idempotencyKey !== "string" ||
    !UUID_RE.test(params.idempotencyKey.trim())
  ) {
    return fail("invalid_input");
  }
  const requestId = params.idempotencyKey.trim();
  const notificationCapability = (params.notificationCapability ?? "").trim();
  if (notificationCapability && !UUID_RE.test(notificationCapability)) {
    return fail("invalid_input");
  }
  // P1 #20 (QA re-sweep 2026-05-12) — granular per-field reasons.
  // Each branch identifies the failing FIELD and the 1-indexed
  // MEMBER number so the UI can render copy like "Person 2 has an
  // invalid phone" instead of "couldn't book the group".
  for (let i = 0; i < params.members.length; i++) {
    const m = params.members[i];
    const memberNumber = i + 1;
    const nameTrim = (m.name ?? "").trim();
    // Name is optional: client sends "Guest N" / "Khách N" as the default
    // placeholder when the organiser doesn't fill in individual names.
    // Allow any non-empty string up to the max length; reject only truly
    // blank or oversized values to guard against crafted payloads.
    if (nameTrim.length > BOOKING_GUEST_NAME_MAX) {
      return fail("invalid_name", memberNumber);
    }
    if (nameTrim.length > 0 && !isValidCustomerName(nameTrim)) {
      return fail("invalid_name", memberNumber);
    }
    // Identity Layer: only the organizer (member 0) must supply a valid phone.
    // Other guests have no contact of their own — an empty phone is valid and
    // makes them a party member server-side (no profile, no phone inherited
    // from the organizer). If a guest DOES provide a phone it must be valid.
    const phoneRaw = (m.phone ?? "").trim();
    if (i === 0 || phoneRaw.length > 0) {
      const phoneOk = validateGuestPhone(phoneRaw);
      if (!phoneOk.ok) {
        return fail("invalid_phone", memberNumber);
      }
    }
    const emailRaw = (m.email ?? "").trim();
    if (emailRaw.length > 0 && !isValidEmailFormat(emailRaw)) {
      return fail("invalid_email", memberNumber);
    }
    if (parseHmToMinutes(m.time ?? "") === null) {
      return fail("invalid_time", memberNumber);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date ?? "")) {
      return fail("invalid_date", memberNumber);
    }
    if (!Array.isArray(m.addonServiceIds ?? [])) {
      return fail("invalid_addons", memberNumber);
    }
    const uniqueAddonIds = new Set(m.addonServiceIds ?? []);
    if (
      Array.from(uniqueAddonIds).some(
        (id) => typeof id !== "string" || id.trim().length === 0,
      )
    ) {
      return fail("invalid_addons", memberNumber);
    }
    if (uniqueAddonIds.size > 8) {
      return fail("too_many_addons", memberNumber);
    }
  }

  const supabase = createPublicClient();

  // 2. Salon ---------------------------------------------------------
  // `profile_complete` is the single source of truth for "salon
  // accepting bookings" (see submitPublicBooking.ts:173 and
  // loadBookingServices.ts where `acceptingBookings` is derived
  // from this column).
  const { data: salonRaw, error: salonErr } = await supabase
    .from("public_salon_profiles" as never)
    .select(
      "id, profile_complete, opening_hours, timezone, booking_closed_dates, subscription_plan, plan_override, feature_flags, phone_otp_enabled, staff_capability_mode",
    )
    .eq("slug", params.shopSlug)
    .maybeSingle();

  if (salonErr || !salonRaw) return fail("salon_not_found");
  const salonRow = salonRaw as unknown as {
    id: string;
    profile_complete?: unknown;
    opening_hours?: unknown;
    timezone?: unknown;
    booking_closed_dates?: unknown;
    subscription_plan?: string | null;
    plan_override?: string | null;
    feature_flags?: Record<string, unknown> | null;
    phone_otp_enabled?: boolean | null;
    staff_capability_mode?: "legacy_all" | "whitelist" | null;
  };
  if (!salonRow.profile_complete) return fail("salon_paused");

  // PR3 — release flag `group_booking` (Beta, default OFF). Refuse the
  // mutation when disabled even though PR2 hides the UI (defense-in-depth).
  if (!isReleaseFeatureEnabled(salonRow, "group_booking")) {
    return fail("feature_not_enabled");
  }

  // A completed request is a retry, not new plan usage. Let it reach the
  // fingerprint-enforcing writer even when the first successful transaction
  // consumed the salon's remaining monthly capacity. The boolean helper
  // exposes no booking/customer data; changed payloads still fail at the
  // durable ledger.
  const { data: completedRequest, error: completedRequestError } =
    await supabase.rpc("group_booking_request_completed" as never, {
      p_salon_id: String(salonRow.id),
      p_request_id: requestId,
    } as never);
  if (completedRequestError) return fail("server_error");
  if (completedRequest !== true) {
    // Plan-tier monthly cap. Group size is the count of new bookings we'd
    // insert, so pass it so a 7-person group can't sneak past a limit that has
    // 6 slots left.
    try {
      await assertBookingLimitAvailable(
        supabase,
        {
          id: String(salonRow.id),
          subscription_plan: salonRow.subscription_plan,
          plan_override: salonRow.plan_override,
          feature_flags: salonRow.feature_flags,
        },
        params.members.length,
      );
    } catch (e) {
      if (e instanceof Error && e.message === "monthly_booking_limit_reached") {
        return fail("monthly_booking_limit_reached");
      }
      throw e;
    }
  }

  // Task #04-C (post #04-B cleanup) — `salons.timezone` is NOT NULL
  // (migration 20260512600000_timezone_required). The legacy
  // `?? "UTC"` fallback was dead code that, before the constraint,
  // would have silently produced 8-hour-offset bookings. We now
  // hard-fail with `server_error` rather than risk wrong slot
  // math; the constraint makes this unreachable in normal flow.
  const timezone =
    typeof salonRow.timezone === "string" && salonRow.timezone.trim().length > 0
      ? salonRow.timezone.trim()
      : null;
  if (timezone === null) {
    Sentry.captureMessage("submitGroupBooking timezone missing on salon row", {
      level: "error",
      extra: { salon_id: salonRow.id, slug: params.shopSlug },
    });
    return fail("server_error");
  }

  const closedYmdSet = parseBookingClosedDateSet(salonRow.booking_closed_dates);
  for (const m of params.members) {
    if (closedYmdSet.has(m.date)) return fail("salon_closed_day");
  }

  // P1.2 — past-date guard, mirrors submitPublicBooking.ts:199. The
  // client also `min`-bounds the date input, but a manually-crafted
  // payload bypasses that. Compares YMD strings in salon timezone to
  // avoid server-tz drift.
  const todayYmd = salonToday(timezone);
  for (const m of params.members) {
    if (m.date < todayYmd) return fail("past_date");
  }

  scope.setTag("salon.id", String(salonRow.id));
  scope.setTag("group.size", String(params.members.length));

  // 3. Services ------------------------------------------------------
  const serviceIds = Array.from(
    new Set(params.members.map((m) => m.serviceId)),
  );

  // Union add-on ids so we can fetch all in one query.
  const addonIdSet = new Set<string>();
  for (const m of params.members) {
    for (const aid of m.addonServiceIds ?? []) {
      if (aid) addonIdSet.add(aid);
    }
  }
  const allFetchIds = Array.from(new Set([...serviceIds, ...addonIdSet]));

  const { data: services, error: svcErr } = await supabase
    .from("public_service_catalog")
    .select(
      "id, name, duration_minutes, buffer_minutes, price_cents, is_addon, addon_timing",
    )
    .in("id", allFetchIds)
    .eq("salon_id", salonRow.id);
  if (svcErr) return fail("server_error");

  const serviceById = new Map<
    string,
    {
      id: string;
      duration: number;
      buffer: number;
      priceCents: number | null;
    }
  >();
  // addonById: is_addon rows only. Keep the timing segments separate so the
  // same closing-boundary model used by individual bookings can determine
  // customer service completion (excluding only the final cleanup buffer).
  type AddonInfo = {
    duration: number;
    buffer: number;
    priceCents: number | null;
    concurrent: boolean;
  };
  const addonById = new Map<string, AddonInfo>();

  for (const s of services ?? []) {
    const sTyped = s as typeof s & {
      is_addon?: unknown;
      addon_timing?: unknown;
    };
    const isAddon = sTyped.is_addon === true;
    if (isAddon) {
      addonById.set(String(s.id), {
        duration: Number(s.duration_minutes) || 0,
        buffer: Number(s.buffer_minutes) || 0,
        priceCents: s.price_cents != null ? Number(s.price_cents) : null,
        concurrent: sTyped.addon_timing === "concurrent",
      });
      // Don't register add-ons in serviceById (they're not main services).
      continue;
    }
    serviceById.set(String(s.id), {
      id: String(s.id),
      duration: Number(s.duration_minutes) || 0,
      buffer: Number(s.buffer_minutes) || 0,
      priceCents: s.price_cents != null ? Number(s.price_cents) : null,
    });
  }
  // Task #04-C FIX 13 — pinpoint which member's service vanished.
  // The select above already filtered `deleted_at IS NULL`, so a
  // missing id means the service was soft-deleted between step 2
  // and submit. UI navigates back to step 2 + highlights the
  // affected card.
  for (let i = 0; i < params.members.length; i++) {
    const m = params.members[i];
    if (!serviceById.has(m.serviceId)) {
      return {
        ok: false,
        reason: "service_unavailable",
        memberNumber: i + 1,
        memberIndex: i,
      };
    }
    if (
      Array.from(new Set(m.addonServiceIds ?? [])).some(
        (addonId) => !addonById.has(addonId),
      )
    ) {
      return fail("invalid_addons", i + 1);
    }
  }

  // 4. Staff ---------------------------------------------------------
  const staffIds = Array.from(new Set(params.members.map((m) => m.staffId)));
  const { data: staffRows, error: staffErr } = await supabase
    .from("public_staff_profiles")
    .select("id")
    .in("id", staffIds)
    .eq("salon_id", salonRow.id)
    .eq("status", "active");
  if (staffErr) return fail("server_error");
  const staffSet = new Set((staffRows ?? []).map((s) => String(s.id)));
  // Task #04-C FIX 12 — pinpoint which member's preferred staff
  // disappeared between arrangement-pick and submit. The select
  // above filtered `status='active'`; the public view already excludes
  // deleted rows, so a
  // missing id means the staff was deleted, paused, or marked
  // inactive in the meantime. UI auto re-runs the scheduler so the
  // remaining members get fresh staff suggestions.
  for (let i = 0; i < params.members.length; i++) {
    const m = params.members[i];
    if (!staffSet.has(m.staffId)) {
      return {
        ok: false,
        reason: "staff_unavailable",
        memberNumber: i + 1,
        memberIndex: i,
      };
    }
  }

  // Write-time capability proof for every caller, including the anonymous
  // wizard. Durable whitelist mode remains fail-closed even after its final
  // staff_services row is deleted.
  const { data: capabilityRows, error: capabilityError } = await supabase
    .from("staff_services")
    .select("staff_id, service_id")
    .in("staff_id", staffIds)
    .in("service_id", allFetchIds);
  if (capabilityError) return fail("server_error");
  if (salonRow.staff_capability_mode === "whitelist") {
    const capabilityKeys = new Set(
      (capabilityRows ?? []).map(
        (row) => `${String(row.staff_id)}:${String(row.service_id)}`,
      ),
    );
    for (let i = 0; i < params.members.length; i++) {
      const member = params.members[i];
      const requiredIds = [
        member.serviceId,
        ...Array.from(new Set(member.addonServiceIds ?? [])),
      ];
      if (
        requiredIds.some(
          (requestedServiceId) =>
            !capabilityKeys.has(`${member.staffId}:${requestedServiceId}`),
        )
      ) {
        return fail("staff_unavailable", i + 1);
      }
    }
  }

  // 5. Resolve each member's UTC range -------------------------------
  // Salon-local YYYY-MM-DD + HH:MM → UTC ISO via the existing
  // DST-safe helper. We avoid `new Date(local)` math here — that path
  // uses the SERVER's timezone, not the salon's.
  type Resolved = {
    member: GroupBookingMember;
    startUtcIso: string;
    endUtcIso: string;
    startMs: number;
    endMs: number;
    serviceCompletionMin: number;
    priceCents: number | null;
    addonPriceCents: number | null;
    addonIds: string[];
    /** First add-on id for the legacy addon_service_id column. */
    firstAddonId: string | null;
  };
  const resolved: Resolved[] = [];
  for (const m of params.members) {
    const svc = serviceById.get(m.serviceId)!;

    // Canonicalize first, then account for each add-on exactly once.
    let addonPriceCentsSum = 0;
    let hasAddonPrice = false;
    let firstAddonId: string | null = null;
    const addonIds: string[] = [];
    const addonTimingSegments: {
      durationMinutes: number;
      bufferMinutes: number;
      concurrent: boolean;
    }[] = [];
    for (const aid of Array.from(new Set(m.addonServiceIds ?? []))) {
      const addon = addonById.get(aid);
      if (!addon) return fail("invalid_addons");
      if (firstAddonId === null) firstAddonId = aid;
      addonIds.push(aid);
      addonTimingSegments.push({
        durationMinutes: addon.duration,
        bufferMinutes: addon.buffer,
        concurrent: addon.concurrent,
      });
      if (addon.priceCents != null) {
        addonPriceCentsSum += addon.priceCents;
        hasAddonPrice = true;
      }
    }

    const timing = computeBookingTiming(
      { durationMinutes: svc.duration, bufferMinutes: svc.buffer },
      addonTimingSegments,
    );
    const startMinutes = parseHmToMinutes(m.time)!;
    const startUtcIso = salonWallTimeToUtcIso(m.date, startMinutes, timezone);
    const startMs = Date.parse(startUtcIso);
    const endMs = startMs + timing.blockMinutes * 60_000;

    const basePriceCents = svc.priceCents;

    resolved.push({
      member: m,
      startUtcIso,
      endUtcIso: new Date(endMs).toISOString(),
      startMs,
      endMs,
      serviceCompletionMin: timing.serviceCompletionMinutes,
      // Main and add-on snapshots stay separate. The database computes the
      // request total once from these canonical components.
      priceCents: basePriceCents,
      addonPriceCents: hasAddonPrice ? addonPriceCentsSum : null,
      addonIds,
      firstAddonId,
    });
  }

  // 5.5. Opening-hours guard — each member's slot must fall within the
  // salon's open window. The group scheduler enforces this on the read
  // path, but a crafted payload could bypass it entirely.
  const hoursCheck = checkGroupWithinOpeningHours({
    openingHoursRaw: salonRow.opening_hours,
    bookingClosedDatesRaw: salonRow.booking_closed_dates,
    members: resolved.map((r) => ({
      dateYmd: r.member.date,
      startMinutes: parseHmToMinutes(r.member.time)!,
      serviceCompletionMinutes: r.serviceCompletionMin,
    })),
  });
  let controlledAfterHoursMinutes: Array<number | null> = resolved.map(
    () => null,
  );
  if (!hoursCheck.ok) {
    if (!trustedExecution) {
      if (hoursCheck.reason === "closed_day") return fail("salon_closed_day");
      return fail("invalid_time", hoursCheck.memberIndex + 1);
    }
    if (
      !trustedExecution.controlledAfterHours.actorUserId ||
      trustedExecution.controlledAfterHours.staffConsentConfirmed !== true
    ) {
      return fail("staff_consent_required");
    }
    // Controlled exceptions are all-explicit: no member may use an auto/Any
    // sentinel. The active-staff check below independently proves every UUID.
    if (
      params.members.some((member) => !/^[0-9a-f-]{36}$/i.test(member.staffId))
    ) {
      return fail("specific_staff_required");
    }
    const afterHoursByMember: Array<number | null> = [];
    for (let memberIndex = 0; memberIndex < resolved.length; memberIndex++) {
      const r = resolved[memberIndex];
      const evaluation = evaluateControlledAfterHours({
        openingHoursRaw: salonRow.opening_hours,
        bookingClosedDatesRaw: salonRow.booking_closed_dates,
        dateYmd: r.member.date,
        startMinutes: parseHmToMinutes(r.member.time)!,
        serviceCompletionMinutes: r.serviceCompletionMin,
      });
      if (evaluation.ok) {
        afterHoursByMember.push(evaluation.afterHoursMinutes);
        continue;
      }
      // A shorter member may still finish inside hours while another member in
      // the same party crosses close. That row remains a normal-hours row.
      if (evaluation.reason === "inside_hours") {
        afterHoursByMember.push(null);
        continue;
      }
      return fail(
        evaluation.reason === "closed_day"
          ? "salon_closed_day"
          : evaluation.reason === "extension_too_long"
            ? "after_hours_limit_exceeded"
            : "outside_hours",
        memberIndex + 1,
      );
    }
    controlledAfterHoursMinutes = afterHoursByMember;
  } else if (trustedExecution) {
    // Never stamp a normal group as after-hours because a crafted caller sent
    // the optional server-only execution object.
    return fail("invalid_after_hours_override");
  }

  // 6. Cross-member conflict check (app-level pre-flight) ------------
  // Two members on the same staff with overlapping ranges = conflict.
  // The DB GIST constraint also catches this at insert time; we run
  // the app check first so we can return a structured list of
  // conflicting indices for the UI to highlight.
  //
  // P1.6 — track in-group conflicts separately from external ones so
  // the UI can show distinct copy. In-group: "two members chose the
  // same staff". External: "another customer just took it".
  const crossMemberConflicts = new Set<number>();
  const externalConflicts = new Set<number>();
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (resolved[i].member.staffId !== resolved[j].member.staffId) continue;
      if (
        intervalsOverlapMs(
          resolved[i].startMs,
          resolved[i].endMs,
          resolved[j].startMs,
          resolved[j].endMs,
        )
      ) {
        crossMemberConflicts.add(i);
        crossMemberConflicts.add(j);
      }
    }
  }

  // 7. Per-member conflict vs existing bookings ----------------------
  // Load occupancy for every salon day involved in the group, then
  // run `checkBookingConflict` per member — the exact same helper
  // single bookings use.
  const distinctDays = Array.from(new Set(params.members.map((m) => m.date)));
  const occByStaff = new Map<string, ConflictCheckBooking[]>();
  for (const ymd of distinctDays) {
    const { startUtc, endUtc } = salonDayRangeUtc(ymd, timezone);
    const { data: rows, error: occupancyError } = await supabase
      .from("bookings")
      .select("id, staff_id, start_time_utc, end_time_utc, status, client_name")
      .eq("salon_id", salonRow.id)
      .gte("start_time_utc", startUtc)
      .lt("start_time_utc", endUtc);
    if (occupancyError) {
      Sentry.captureException(occupancyError, {
        tags: {
          "booking.flow": "group",
          "booking.read": "occupancy",
        },
        extra: { salonId: salonRow.id, dateYmd: ymd },
      });
      return fail("server_error");
    }
    for (const row of rows ?? []) {
      const sid = row.staff_id == null ? "" : String(row.staff_id);
      if (!sid) continue;
      const arr = occByStaff.get(sid) ?? [];
      arr.push({
        id: String(row.id),
        staff_id: sid,
        start_time_utc: row.start_time_utc as string | null,
        end_time_utc: row.end_time_utc as string | null,
        status: String(row.status ?? ""),
        client_name: String(row.client_name ?? ""),
      });
      occByStaff.set(sid, arr);
    }
  }

  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    const occ = occByStaff.get(r.member.staffId) ?? [];
    const conflict = checkBookingConflict({
      staffId: r.member.staffId,
      startUtcIso: r.startUtcIso,
      endUtcIso: r.endUtcIso,
      existingBookings: occ,
    });
    if (conflict !== null) externalConflicts.add(i);
  }

  if (crossMemberConflicts.size > 0 || externalConflicts.size > 0) {
    // Cross-member is the more actionable category — surface it
    // first if both are present. The UI highlights all conflicting
    // indices regardless.
    const all = new Set([...crossMemberConflicts, ...externalConflicts]);
    return {
      ok: false,
      reason: "slot_conflict",
      conflictingMembers: Array.from(all).sort((a, b) => a - b),
      conflictKind: crossMemberConflicts.size > 0 ? "cross_member" : "external",
    };
  }

  // 8. Atomic RPC insert ---------------------------------------------
  // RPC owns the transaction boundary. Request-scoped idempotency: the same
  // `idempotencyKey` is stamped on every member. The durable ledger returns
  // the original result for an exact retry and rejects a changed payload.
  const idem = requestId;
  const payload = resolved.map((r, i) => {
    const phoneOk = validateGuestPhone(r.member.phone);
    const phoneDigits = phoneOk.ok ? phoneOk.digits : r.member.phone;
    const emailRaw = (r.member.email ?? "").trim();
    const notesRaw = (r.member.notes ?? "").trim();
    return {
      salon_id: salonRow.id,
      staff_id: r.member.staffId,
      service_id: r.member.serviceId,
      // Use member name if organiser filled it in; fall back to "Guest N"
      // placeholder so Party Link claim can always replace it with the
      // real guest's name even if the organiser left it as default.
      client_name: r.member.name.trim() || `Guest ${i + 1}`,
      client_phone: phoneDigits,
      client_email: emailRaw.length > 0 ? emailRaw : null,
      client_notes: notesRaw.length > 0 ? notesRaw : null,
      start_time_utc: r.startUtcIso,
      end_time_utc: r.endUtcIso,
      price_cents: r.priceCents,
      // Add-on legacy columns: first addon id + sum of addon prices.
      addon_service_id: r.firstAddonId,
      // Complete authoritative add-on list for the database hours guard. The
      // legacy single column remains for compatibility; this array lets the
      // SECURITY DEFINER boundary verify every sequential add-on before write.
      addon_service_ids: r.addonIds,
      addon_price_cents: r.addonPriceCents,
      wave_number: r.member.waveNumber ?? 1,
      // Couple/group "seat next to each other" preference. Persisted
      // inside the SECURITY DEFINER RPC (the anon client can't UPDATE
      // bookings under RLS). COALESCE default false in the RPC.
      seat_together: params.seatTogether === true,
      staff_requested_by_client: true,
      idempotency_key: idem,
      // One independently random capability is shared by every member in the
      // same request. The writer rejects mixed values and stores only its hash
      // on the service-role-only durable request ledger.
      notification_capability: notificationCapability || null,
      // Language the organizer was browsing in — persisted on every member row
      // so each guest's transactional SMS matches it. Read by the RPC as a
      // jsonb key; absent/null → column stays null and the SMS sender falls
      // back to customer_preferences.
      client_locale: params.language ?? null,
      booking_channel: params.bookingChannel ?? "online",
      // One voucher belongs to the organizer/request. The private RPC validates
      // and redeems it atomically with every member and itemized add-on.
      voucher_id:
        i === 0 ? (params.voucherRedemption?.voucher_id ?? null) : null,
      // Ignored by the public RPC. The private desk RPC consumes this value to
      // stamp the matching booking row after the atomic group insert.
      after_hours_minutes: controlledAfterHoursMinutes[i],
    };
  });

  // OTP gate (sabotage shield) — a new request needs a valid, unconsumed
  // phone_otp_sessions row. A completed durable request may reuse its consumed
  // proof only to reach the fingerprint check and retrieve the original result;
  // changed data still fails closed. The SQL wrapper locks and consumes a fresh
  // proof in the same transaction, so any booking/finalization failure rolls
  // the consumption back as well.
  let otpToConsume: string | null = null;
  if (salonRow.phone_otp_enabled === true) {
    const leadValidation = validateGuestPhone(params.members[0]?.phone ?? "");
    const leadDigits = leadValidation.ok ? leadValidation.digits : "";
    const sessionId = (params.otpSessionId ?? "").trim();
    if (!sessionId) return fail("otp_required");
    if (!leadDigits) return fail("otp_invalid");
    const { data: otpValid, error: otpValidationError } = await supabase.rpc(
      "validate_group_booking_otp_session" as never,
      {
        p_session_id: sessionId,
        p_salon_id: String(salonRow.id),
        p_phone: leadDigits,
        p_request_id: requestId,
      } as never,
    );
    if (otpValidationError || otpValid !== true) {
      return fail("otp_invalid");
    }
    otpToConsume = sessionId;
  }

  let rpcData: unknown;
  let rpcErr: { code?: string; message?: string } | null;
  if (trustedExecution) {
    try {
      const privateWrite = await trustedExecution.insertGroupBookings(payload);
      rpcData = privateWrite.data;
      rpcErr = privateWrite.error;
    } catch (error) {
      Sentry.captureException(error, {
        tags: { "booking.rpc": "insert_controlled_after_hours_group_bookings" },
      });
      return fail("server_error");
    }
  } else {
    const publicWrite = await supabase.rpc(
      "insert_group_bookings" as never,
      {
        p_bookings: payload,
        p_otp_session_id: otpToConsume,
      } as never,
    );
    rpcData = publicWrite.data;
    rpcErr = publicWrite.error;
  }

  if (rpcErr) {
    Sentry.captureException(rpcErr, {
      tags: {
        "booking.rpc": "insert_group_bookings",
        "booking.flow": "group",
      },
      extra: { code: rpcErr.code, message: rpcErr.message },
    });
    // 23P01 / 23505 should be caught inside the RPC and surface as
    // structured JSON; if they reach here it means the RPC itself
    // didn't trap them (e.g. older deployed version).
    if (rpcErr.code === "23P01") {
      // DB-level race → another customer took it. Can't attribute
      // to a specific in-group pair, so kind = external.
      return {
        ok: false,
        reason: "slot_conflict",
        conflictingMembers: [],
        conflictKind: "external",
      };
    }
    if (rpcErr.code === "23505") return fail("duplicate_submission");
    return fail("server_error");
  }

  const result = rpcData as {
    success?: boolean;
    code?: string;
    group_id?: string;
    booking_ids?: string[];
    idempotent_replay?: boolean;
  } | null;
  if (!result || typeof result !== "object") return fail("server_error");
  if (result.success === false) {
    const code = result.code ?? "";
    if (code === "slot_conflict") {
      // DB-level race → another customer took it. Can't attribute
      // to a specific in-group pair, so kind = external.
      return {
        ok: false,
        reason: "slot_conflict",
        conflictingMembers: [],
        conflictKind: "external",
      };
    }
    if (code === "duplicate_submission") return fail("duplicate_submission");
    if (code === "idempotency_conflict") return fail("idempotency_conflict");
    if (code === "invalid_group_size") return fail("invalid_group_size");
    if (code === "invalid_addons") return fail("invalid_addons");
    if (code === "too_many_addons") return fail("too_many_addons");
    if (code === "invalid_notification_capability") return fail("invalid_input");
    if (code === "otp_required") return fail("otp_required");
    if (code === "otp_invalid") return fail("otp_invalid");
    if (code === "staff_incapable") return fail("staff_unavailable");
    if (code === "outside_hours" || code === "invalid_booking_time") {
      return fail("invalid_time");
    }
    Sentry.captureMessage("insert_group_bookings unknown error code", {
      level: "error",
      extra: { code },
    });
    return fail("server_error");
  }
  if (
    result.success !== true ||
    typeof result.group_id !== "string" ||
    !Array.isArray(result.booking_ids)
  ) {
    return fail("server_error");
  }

  // The owner/admin "new booking" alert for the party is dispatched from
  // stampGroupBookingIdentity below — this function runs in the browser for the
  // public flow, where the sender's service-role client throws and the failure
  // is swallowed. See groupBookingSideEffects.

  // Identity Layer: the client_profiles resolve (per-member, dedup by phone,
  // placeholder-name guard, visit_count bump, FK stamp) now happens INSIDE
  // insert_group_bookings via resolve_client_profile() — atomic + server-
  // authoritative. The old best-effort browser upsert was removed (migration
  // 20260614110000); under RLS it could silently no-op, and members without
  // their own phone (party members) must NOT get a profile keyed to the
  // organizer's number. Keeping it here would also double-count visits.

  // A successful group result is all-or-nothing. Never render confirmation for
  // a partial/contract-drift response.
  if (result.booking_ids.length !== params.members.length) {
    Sentry.captureMessage("group_booking_partial_rollback", {
      level: "error",
      tags: {
        "booking.rpc": "insert_group_bookings",
        "booking.flow": "group",
      },
      extra: {
        groupId: result.group_id,
        successCount: result.booking_ids.length,
        totalCount: params.members.length,
        salonId: salonRow.id,
        slug: params.shopSlug,
      },
    });
    return fail("server_error");
  }

  const bookingIdList = result.booking_ids.map((s) => String(s));
  const idempotentReplay = result.idempotent_replay === true;
  // NOTE: no-show card flagging for the GROUP lead is done server-side in
  // createDeskGroup (desk path); this function also runs in the browser
  // (online group wizard) so it must NOT import the server-only gate here.

  // Stamp booking_channel on every member row (+ verification on the organizer).
  // MUST go through a server action: this function runs in the browser for the
  // online flow, where anon UPDATEs on `bookings` silently affect 0 rows (RLS).
  // `otpToConsume` — not params.otpSessionId — is the session actually validated
  // against the organizer's phone above, so we only record verified evidence.
  // Awaited, not fire-and-forget: the wizard renders its confirmation screen as
  // soon as this resolves, and an in-flight server-action request can be torn
  // down by that transition — which would silently put us back at NULL. The
  // action itself defers the writes to after(), so awaiting costs one round
  // trip, not the DB work.
  await stampGroupBookingIdentity({
    bookingIds: bookingIdList,
    organizerBookingId: bookingIdList[0] ?? null,
    bookingChannel: params.bookingChannel ?? "online",
    otpSessionId: otpToConsume,
    // The durable ledger returns the original rows on an exact retry. Keep the
    // idempotent field stamps, but do not fan out a second owner notification.
    ownerNotify: bookingIdList[0] && !idempotentReplay
      ? {
          salonId: String(salonRow.id),
          bookingId: bookingIdList[0],
          event: "new",
          groupSize: bookingIdList.length,
        }
      : undefined,
  }).catch((e) =>
    console.error("[submitGroupBooking] channel/verification stamp failed", e),
  );

  // The public DB wrapper now locks, consumes and stamps the organizer OTP in
  // the same transaction as all group members. There is intentionally no
  // post-commit consume/finalize fallback here: a success means the evidence
  // is durable, while any finalize failure rolls the whole write back.

  // Group confirmation SMS to the primary contact (all members share the
  // organizer's phone). One summary message for the whole party — the group
  // path previously sent NO confirmation at all, unlike individual bookings.
  try {
    if (idempotentReplay) {
      return {
        ok: true,
        groupId: result.group_id,
        bookingIds: bookingIdList,
        idempotentReplay: true,
      };
    }
    const organizer = params.members[0];
    const organizerPhoneOk = validateGuestPhone(organizer?.phone ?? "");
    const earliest = resolved.reduce(
      (min, r) => (r.startMs < min.startMs ? r : min),
      resolved[0],
    );
    if (organizerPhoneOk.ok && earliest && bookingIdList[0]) {
      const appUrl =
        typeof window !== "undefined"
          ? ""
          : (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() ||
            "https://nailiq.ca";
      await fetch(`${appUrl}/api/booking/sms-confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId: bookingIdList[0],
          salonId: String(salonRow.id),
          clientPhone: organizerPhoneOk.digits,
          clientName: organizer?.name ?? null,
          partySize: params.members.length,
          startTimeUtc: earliest.startUtcIso,
          language: params.language ?? null,
          // Only what the organizer actually ticked; stamped on the organizer's
          // booking alone, not fanned out across the party.
          smsConsent: params.smsConsent === true,
          groupId: result.group_id,
        }),
      });
    }
  } catch (e) {
    console.error("[submitGroupBooking] group sms-confirm dispatch failed", e);
  }

  return {
    ok: true,
    groupId: result.group_id,
    bookingIds: bookingIdList,
    idempotentReplay: false,
  };
}
