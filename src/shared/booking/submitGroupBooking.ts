import * as ErrorReporter from "@/shared/observability/errorReporter";
import {
  ConflictCheckBooking,
  checkBookingConflict,
} from "@/shared/lib/conflictCheck";
import { assertBookingLimitAvailable } from "@/shared/booking/assertBookingLimit";
import { runBookingOrchestrator } from "@/shared/booking/bookingOrchestrator";
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
import {
  groupBookingInstantMatches,
  parseGroupBookingPricingQuote,
  type GroupBookingPricingQuote,
} from "@/shared/booking/groupBookingPricing";

/**
 * Group booking submission — 2–4 friends/family booking together.
 *
 * Each member becomes its own `bookings` row, all sharing a `group_id` UUID.
 * Public writes are atomic through the server-only `create_group_bookings`
 * quote/fingerprint contract; the authenticated desk override retains its
 * existing controlled-after-hours writer.
 *
 * Reuses (DOES NOT reimplement):
 *   - `salonWallTimeToUtcIso` for date+time → UTC conversion
 *     (DST-safe binary search; handles every salon timezone)
 *   - `checkBookingConflict` for app-level pre-flight check (same
 *     contract as `submitPublicBooking.ts`)
 *   - `bookings_no_overlap` GIST EXCLUDE constraint as DB-level
 *     guard against true races; the RPC translates 23P01 → the
 *     `slot_conflict` error code
 *   - `idempotency_key` UNIQUE index for double-submit protection;
 *     the RPC translates 23505 → `duplicate_submission`
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
  /** False when the scheduler resolved an "Any available" request. */
  staffRequestedByClient?: boolean;
  /** YYYY-MM-DD in salon-local time (not UTC). */
  date: string;
  /** HH:MM (24h) in salon-local time. */
  time: string;
  /** Phase 6.1 — wave this member belongs to (1 for normal bookings). */
  waveNumber?: number;
  /** Add-on service IDs selected for this member. The canonical public create
   * stores rows and pricing in the same transaction. Sequential add-ons extend
   * end_time; concurrent add-ons add price but +0 time. */
  addonServiceIds?: string[];
};

export type GroupBookingParams = {
  shopSlug: string;
  members: GroupBookingMember[];
  /** Client-generated UUID (crypto.randomUUID()). Submitting the same
   * key a second time hits the UNIQUE constraint and returns
   * `duplicate_submission` rather than creating a second group. */
  idempotencyKey: string;
  /** Task #09-11 honeypot. Optional; matches the public booking
   *  contract. UI plumbing in `BookingGroupFlow.tsx` is TODO —
   *  accepting the field now means a future hidden input there can
   *  ship as a UI-only change. Empty / unset = pass-through to the
   *  real flow. */
  clientWebsite?: string;
  /** Group/couple wants to be seated next to each other (head-spa
   *  curtain "couple" space, or friends sitting together). Persisted
   *  on every member row by the canonical transaction (or the separately
   *  authorized controlled-after-hours writer) so the receptionist board can
   *  show a 💕 badge. Default false. */
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
  /** Public canonical pricing inputs. Voucher validation/redemption and all
   * monetary allocation happen inside create_group_bookings. */
  voucherCode?: string | null;
  applyEmailDiscount?: boolean;
  expectedPricingQuote?: GroupBookingPricingQuote | null;
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
  /** Tokenized card is forwarded only into the trusted group-create boundary. */
  noShowCardSourceId?: string | null;
  noShowCardVerificationToken?: string | null;
  noShowConsent?: boolean;
};

export type GroupBookingResult =
  | {
      ok: true;
      groupId: string;
      bookingIds: string[];
      /** Required for public and normal desk bookings. Only the separately
       * authorized controlled-after-hours compatibility writer (and the
       * honeypot no-write response) can return null. */
      pricing: GroupBookingPricingQuote | null;
      /** Server-minted action proof for organizer card capture, when required. */
      cardManagementToken: string | null;
      /** True when the party is committed but no-show card work still needs
       * reconciliation. This is a success-state concern, never a reason to
       * ask the organizer to submit the party again. */
      cardManagementPending: boolean;
    }
  | {
      ok: false;
      reason: "pricing_changed";
      pricing: GroupBookingPricingQuote;
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
        | "pricing_required"
        | "pricing_invalid"
        | "idempotency_conflict"
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
 * callers can only reach the canonical public boundary, which rejects
 * out-of-hours rows. The desk action supplies a privileged writer only
 * after proving Owner/Admin, an attributable auth user and staff consent.
 */
export type TrustedGroupBookingExecution =
  | {
      kind: "controlled_after_hours";
      controlledAfterHours: {
        actorUserId: string;
        staffConsentConfirmed: true;
      };
      insertGroupBookings: (payload: Array<Record<string, unknown>>) => Promise<{
        data: unknown;
        error: { code?: string; message?: string } | null;
      }>;
    }
  | {
      kind: "canonical_desk";
      createGroupBookings: (input: {
        salonId: string;
        bookings: Array<{
          serviceId: string;
          staffId: string;
          startTimeUtc: string;
          endTimeUtc: string;
          addonServiceIds: string[];
          clientName: string;
          clientPhone: string | null;
          clientEmail: string | null;
          clientNotes: string | null;
          staffRequestedByClient: boolean;
          waveNumber: number;
          seatTogether: boolean;
          clientLocale: "en" | "vi" | null;
          resourceId: null;
        }>;
        voucherCode: null;
        applyEmailDiscount: boolean;
        idempotencyKey: string;
      }) => Promise<
        | {
            ok: true;
            groupId: string;
            bookingIds: string[];
            pricing: GroupBookingPricingQuote;
          }
        | {
            ok: false;
            code:
              | "slot_conflict"
              | "monthly_booking_limit_reached"
              | "idempotency_conflict"
              | "pricing_changed"
              | "create_unavailable"
              | "pricing_invalid";
            quote?: GroupBookingPricingQuote;
          }
      >;
    };

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

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
    "slot_conflict" | "pricing_changed"
  >,
  memberNumber: number | null = null,
): GroupBookingResult {
  // Structured failures never throw, so without this they're invisible to
  // error_logs/NailIQ Error Monitor — inherits the booking.flow/salon.slug tags set on the
  // scope at the top of submitGroupBooking.
  ErrorReporter.captureMessage(`group booking rejected: ${reason}`, {
    level: "warning",
    tags: { "booking.fail_reason": reason },
    extra: { memberNumber },
  });
  return { ok: false, reason, memberNumber };
}

async function executeGroupBooking(
  params: GroupBookingParams,
  trustedExecution?: TrustedGroupBookingExecution,
): Promise<GroupBookingResult> {
  const controlledAfterHoursExecution =
    trustedExecution?.kind === "controlled_after_hours"
      ? trustedExecution
      : null;
  const canonicalDeskExecution =
    trustedExecution?.kind === "canonical_desk" ? trustedExecution : null;
  const scope = ErrorReporter.getCurrentScope();
  scope.setTag("booking.flow", "submit_group_booking");
  scope.setTag("salon.slug", params.shopSlug);

  // Task #09-11 — honeypot guard. Mirrors `submitPublicBooking`.
  // `BookingGroupFlow.tsx` does not yet render a hidden input that
  // sets this field, so today the branch never fires from the real
  // UI — accepting the field positions the server side to short-
  // circuit silently as soon as the UI plumbing lands.
  if ((params.clientWebsite ?? "").trim().length > 0) {
    ErrorReporter.captureMessage("group booking honeypot tripped", {
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
      pricing: null,
      cardManagementToken: null,
      cardManagementPending: false,
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
    params.idempotencyKey.trim().length === 0
  ) {
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
      "id, profile_complete, opening_hours, timezone, booking_closed_dates, subscription_plan, plan_override, feature_flags, phone_otp_enabled",
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
  };
  if (!salonRow.profile_complete) return fail("salon_paused");

  // PR3 — release flag `group_booking` (Beta, default OFF). Refuse the
  // mutation when disabled even though PR2 hides the UI (defense-in-depth).
  if (!isReleaseFeatureEnabled(salonRow, "group_booking")) {
    return fail("feature_not_enabled");
  }

  // Plan-tier monthly cap. Group size is the count of new bookings
  // we'd insert, so pass it so a 7-person group can't sneak past a
  // limit that has 6 slots left.
  if (controlledAfterHoursExecution) {
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
    ErrorReporter.captureMessage("submitGroupBooking timezone missing on salon row", {
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

  // Write-time capability proof. The scheduler already filters staff, but a
  // crafted payload must not assign a service/add-on to someone who cannot do
  // it. As elsewhere in NailIQ, zero capability rows means legacy "all staff
  // can do all services"; once any rows exist, every requested item must match.
  if (controlledAfterHoursExecution) {
    const { data: capabilityRows, error: capabilityError } = await supabase
      .from("staff_services")
      .select("staff_id, service_id")
      .in("staff_id", staffIds)
      .in("service_id", allFetchIds);
    if (capabilityError) return fail("server_error");
    if ((capabilityRows ?? []).length > 0) {
      const capabilityKeys = new Set(
        (capabilityRows ?? []).map(
          (row) => `${String(row.staff_id)}:${String(row.service_id)}`,
        ),
      );
      for (let i = 0; i < params.members.length; i++) {
        const member = params.members[i];
        const requiredIds = [
          member.serviceId,
          ...(member.addonServiceIds ?? []),
        ];
        if (
          requiredIds.some(
            (serviceId) =>
              !capabilityKeys.has(`${member.staffId}:${serviceId}`),
          )
        ) {
          return fail("staff_unavailable", i + 1);
        }
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

    // Add-on resolution: sum sequential block minutes + prices.
    // Invalid / non-is_addon IDs are silently skipped (don't hard-fail).
    let addonPriceCentsSum = 0;
    let hasAddonPrice = false;
    let firstAddonId: string | null = null;
    const addonIds: string[] = [];
    const addonTimingSegments: {
      durationMinutes: number;
      bufferMinutes: number;
      concurrent: boolean;
    }[] = [];
    for (const aid of m.addonServiceIds ?? []) {
      const addon = addonById.get(aid);
      if (!addon) continue; // not is_addon for this salon — skip
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

    // Preserve null price semantics (same as loadGroupSmartSchedule).
    const basePriceCents = svc.priceCents;
    const effectivePriceCents: number | null =
      basePriceCents != null || hasAddonPrice
        ? (basePriceCents ?? 0) + addonPriceCentsSum
        : null;

    resolved.push({
      member: m,
      startUtcIso,
      endUtcIso: new Date(endMs).toISOString(),
      startMs,
      endMs,
      serviceCompletionMin: timing.serviceCompletionMinutes,
      priceCents: effectivePriceCents,
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
    if (!controlledAfterHoursExecution) {
      if (hoursCheck.reason === "closed_day") return fail("salon_closed_day");
      return fail("invalid_time", hoursCheck.memberIndex + 1);
    }
    if (
      !controlledAfterHoursExecution.controlledAfterHours.actorUserId ||
      controlledAfterHoursExecution.controlledAfterHours.staffConsentConfirmed !== true
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
  } else if (controlledAfterHoursExecution) {
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
  // The public canonical RPC owns availability and checks committed
  // idempotency before re-evaluating occupancy. Re-running browser preflight
  // after a lost response would otherwise see its own committed rows as a
  // conflict and make the successful booking unrecoverable. Only the
  // controlled-after-hours compatibility path keeps the richer local conflict
  // attribution.
  if (controlledAfterHoursExecution) {
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
    const { data: rows } = await supabase
      .from("bookings")
      .select("id, staff_id, start_time_utc, end_time_utc, status, client_name")
      .eq("salon_id", salonRow.id)
      .gte("start_time_utc", startUtc)
      .lt("start_time_utc", endUtc);
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
  }

  // 8. Atomic RPC insert ---------------------------------------------
  // RPC owns the transaction boundary. Single-key idempotency: the
  // same `idempotencyKey` is stamped on every member so a re-submit
  // of the exact same payload hits the partial UNIQUE on member 1
  // and the function returns `duplicate_submission`.
  const idem = params.idempotencyKey;
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
      staff_requested_by_client: r.member.staffRequestedByClient ?? true,
      idempotency_key: idem,
      // Language the organizer was browsing in — persisted on every member row
      // so each guest's transactional SMS matches it. Read by the RPC as a
      // jsonb key; absent/null → column stays null and the SMS sender falls
      // back to customer_preferences.
      client_locale: params.language ?? null,
      // Ignored by the public RPC. The private desk RPC consumes this value to
      // stamp the matching booking row after the atomic group insert.
      after_hours_minutes: controlledAfterHoursMinutes[i],
    };
  });

  // OTP gate (sabotage shield) — the organizer's phone must carry a valid,
  // unconsumed phone_otp_sessions row (same artifact the individual flow uses).
  // Validated up front; consumed only AFTER the group commits, so a partial
  // failure doesn't burn the session. Anon RLS hides consumed/expired rows.
  let otpToConsume: string | null = null;
  if (salonRow.phone_otp_enabled === true) {
    const leadValidation = validateGuestPhone(params.members[0]?.phone ?? "");
    const leadDigits = leadValidation.ok ? leadValidation.digits : "";
    const sessionId = (params.otpSessionId ?? "").trim();
    if (!sessionId) return fail("otp_required");
    if (!leadDigits) return fail("otp_invalid");
    if (trustedExecution) {
      const { data: otpValid, error: otpValidationError } = await supabase.rpc(
        "validate_phone_otp_session" as never,
        {
          p_session_id: sessionId,
          p_salon_id: String(salonRow.id),
          p_phone: leadDigits,
        } as never,
      );
      if (otpValidationError || otpValid !== true) {
        return fail("otp_invalid");
      }
    }
    otpToConsume = sessionId;
  }

  const canonicalBookings = resolved.map((r, index) => {
    const phone = validateGuestPhone(r.member.phone);
    return {
      serviceId: r.member.serviceId,
      staffId: r.member.staffId,
      startTimeUtc: r.startUtcIso,
      endTimeUtc: r.endUtcIso,
      addonServiceIds: r.addonIds,
      clientName: r.member.name.trim() || `Guest ${index + 1}`,
      clientPhone: phone.ok ? phone.digits : null,
      clientEmail: r.member.email?.trim().toLowerCase() || null,
      clientNotes: r.member.notes?.trim() || null,
      staffRequestedByClient: r.member.staffRequestedByClient ?? true,
      waveNumber: r.member.waveNumber ?? 1,
      seatTogether: params.seatTogether === true,
      clientLocale: params.language ?? null,
      resourceId: null,
    };
  });

  let groupId: string;
  let bookingIdList: string[];
  let authoritativePricing: GroupBookingPricingQuote | null = null;
  let publicCardManagementToken: string | null = null;
  let publicCardManagementPending = false;
  if (controlledAfterHoursExecution) {
    let rpcData: unknown;
    let rpcErr: { code?: string; message?: string } | null;
    try {
      const privateWrite = await controlledAfterHoursExecution.insertGroupBookings(payload);
      rpcData = privateWrite.data;
      rpcErr = privateWrite.error;
    } catch (error) {
      ErrorReporter.captureException(error, {
        tags: { "booking.rpc": "insert_controlled_after_hours_group_bookings" },
      });
      return fail("server_error");
    }
    if (rpcErr) {
      ErrorReporter.captureException(rpcErr, {
        tags: {
          "booking.rpc": "insert_controlled_after_hours_group_bookings",
          "booking.flow": "group",
        },
        extra: { code: rpcErr.code, message: rpcErr.message },
      });
      if (rpcErr.code === "23P01") {
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
    } | null;
    if (!result || typeof result !== "object") return fail("server_error");
    if (result.success === false) {
      const code = result.code ?? "";
      if (code === "slot_conflict") {
        return {
          ok: false,
          reason: "slot_conflict",
          conflictingMembers: [],
          conflictKind: "external",
        };
      }
      if (code === "duplicate_submission") return fail("duplicate_submission");
      if (code === "invalid_group_size") return fail("invalid_group_size");
      if (code === "outside_hours" || code === "invalid_booking_time") {
        return fail("invalid_time");
      }
      return fail("server_error");
    }
    if (
      result.success !== true ||
      typeof result.group_id !== "string" ||
      !Array.isArray(result.booking_ids) ||
      result.booking_ids.length !== params.members.length ||
      result.booking_ids.some((id) => typeof id !== "string" || !id)
    ) {
      return fail("server_error");
    }
    groupId = result.group_id;
    bookingIdList = result.booking_ids;
  } else if (canonicalDeskExecution) {
    const deskResult = await canonicalDeskExecution.createGroupBookings({
      salonId: String(salonRow.id),
      bookings: canonicalBookings,
      voucherCode: null,
      applyEmailDiscount: false,
      idempotencyKey: idem,
    });
    if (!deskResult.ok) {
      if (deskResult.code === "slot_conflict") {
        return { ok: false, reason: "slot_conflict", conflictingMembers: [], conflictKind: "external" };
      }
      if (deskResult.code === "monthly_booking_limit_reached") {
        return fail("monthly_booking_limit_reached");
      }
      if (deskResult.code === "idempotency_conflict") {
        return fail("idempotency_conflict");
      }
      if (deskResult.code === "pricing_changed" && deskResult.quote) {
        return { ok: false, reason: "pricing_changed", pricing: deskResult.quote };
      }
      return fail("server_error");
    }
    if (
      deskResult.bookingIds.length !== params.members.length ||
      deskResult.pricing.groupSize !== deskResult.bookingIds.length
    ) return fail("pricing_invalid");
    groupId = deskResult.groupId;
    bookingIdList = deskResult.bookingIds;
    authoritativePricing = deskResult.pricing;
  } else {
    const expected = params.expectedPricingQuote;
    if (!expected) return fail("pricing_required");
    if (
      expected.salonId !== String(salonRow.id) ||
      expected.groupSize !== params.members.length ||
      expected.memberQuotes.some((member, index) => {
        const current = resolved[index];
        return !current ||
          member.memberIndex !== index ||
          member.serviceId !== current.member.serviceId ||
          member.staffId !== current.member.staffId ||
          !groupBookingInstantMatches(member.startTimeUtc, current.startUtcIso) ||
          !groupBookingInstantMatches(member.endTimeUtc, current.endUtcIso) ||
          member.addonServiceIds.length !== current.addonIds.length ||
          member.addonServiceIds.some((id, addonIndex) => id !== current.addonIds[addonIndex]);
      })
    ) return fail("pricing_required");
    let response: Response;
    try {
      response = await fetch("/api/booking/group-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salonId: String(salonRow.id),
          bookings: canonicalBookings,
          voucherCode: params.voucherCode?.trim().toUpperCase() || null,
          applyEmailDiscount: params.applyEmailDiscount === true,
          idempotencyKey: idem,
          expectedPricingFingerprint: expected.pricingFingerprint,
          otpSessionId: params.otpSessionId ?? null,
          cardSourceId: params.noShowCardSourceId?.trim() || undefined,
          cardVerificationToken: params.noShowCardVerificationToken?.trim() || undefined,
          noShowConsent: params.noShowConsent === true || undefined,
        }),
      });
    } catch {
      return fail("server_error");
    }
    const apiResult = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!apiResult || typeof apiResult !== "object") return fail("server_error");
    if (apiResult.ok !== true) {
      const code = typeof apiResult.code === "string" ? apiResult.code : "";
      if (code === "pricing_changed") {
        const pricing = parseGroupBookingPricingQuote(apiResult.quote, {
          voucherCode: params.voucherCode,
        });
        return pricing
          ? { ok: false, reason: "pricing_changed", pricing }
          : fail("pricing_invalid");
      }
      if (code === "idempotency_conflict") return fail("idempotency_conflict");
      if (code === "slot_conflict") {
        return { ok: false, reason: "slot_conflict", conflictingMembers: [], conflictKind: "external" };
      }
      if (code === "monthly_booking_limit_reached") {
        return fail("monthly_booking_limit_reached");
      }
      if (code === "otp_required") return fail("otp_required");
      if (code === "otp_invalid") return fail("otp_invalid");
      return fail("server_error");
    }
    const pricing = parseGroupBookingPricingQuote(apiResult.pricing, {
      voucherCode: params.voucherCode,
    });
    const responseIds = Array.isArray(apiResult.bookingIds)
      ? apiResult.bookingIds.filter((id): id is string => typeof id === "string" && Boolean(id))
      : [];
    if (
      !pricing ||
      typeof apiResult.groupId !== "string" ||
      !apiResult.groupId ||
      responseIds.length !== params.members.length ||
      pricing.groupSize !== responseIds.length
    ) return fail("pricing_invalid");
    groupId = apiResult.groupId;
    bookingIdList = responseIds;
    authoritativePricing = pricing;
    publicCardManagementToken = typeof apiResult.cardManagementToken === "string"
      ? apiResult.cardManagementToken
      : null;
    publicCardManagementPending = apiResult.cardManagementPending === true;
  }

  // Phase-A compatibility only for the separately authorized controlled
  // after-hours workflow. Public browser and normal desk groups never enter
  // this branch: canonical create already persists every add-on atomically
  // with its receipt.
  if (controlledAfterHoursExecution) {
    await Promise.all(
      params.members.map(async (member, index) => {
        const addonIds = (member.addonServiceIds ?? []).filter((id) => addonById.has(id));
        const bookingId = bookingIdList[index];
        if (!bookingId || addonIds.length === 0) return;
        try {
          await supabase.rpc("add_booking_addons", {
            p_booking_id: bookingId,
            p_service_ids: addonIds,
          });
        } catch (error) {
          console.error("[submitGroupBooking] controlled add-on persistence failed", error);
        }
      }),
    );
  }
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
    ownerNotify: bookingIdList[0]
      ? {
          salonId: String(salonRow.id),
          bookingId: bookingIdList[0],
          event: "new",
          groupSize: bookingIdList.length,
        }
      : undefined,
    authoritativeConfirmation: authoritativePricing && bookingIdList[0]
      ? {
          organizerBookingId: bookingIdList[0],
          salonId: String(salonRow.id),
          shopSlug: params.shopSlug,
        }
      : undefined,
  }).catch((e) =>
    console.error("[submitGroupBooking] channel/verification stamp failed", e),
  );

  // Finalize the organizer's durable phone trust and consume the OTP in the
  // same transaction. Group bookings previously burned the session without
  // ever setting client_profiles.phone_verified_at.
  if (otpToConsume && bookingIdList[0]) {
    const { data: finalized, error: finalizeError } = await supabase.rpc(
      "finalize_public_booking_profile" as never,
      {
        p_booking_id: bookingIdList[0],
        p_otp_session_id: otpToConsume,
        p_marketing_consent: false,
      } as never,
    );
    const finalizeResult = finalized as {
      success?: boolean;
      code?: string;
    } | null;
    if (finalizeError || finalizeResult?.success !== true) {
      ErrorReporter.captureMessage("group_booking_profile_finalize_failed", {
        level: "error",
        tags: {
          "booking.rpc": "finalize_public_booking_profile",
          "booking.flow": "group",
        },
        extra: {
          code: finalizeResult?.code ?? null,
          message: finalizeError?.message ?? null,
          organizerBookingId: bookingIdList[0],
        },
      });

      // Preserve single-use OTP if code deploys before the migration.
      const consumeAppUrl =
        typeof window !== "undefined"
          ? ""
          : (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() ||
            "https://nailiq.ca";
      void fetch(`${consumeAppUrl}/api/booking-otp/consume-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: otpToConsume }),
      });
    }
  }

  // Group confirmation SMS to the primary contact (all members share the
  // organizer's phone). One summary message for the whole party — the group
  // path previously sent NO confirmation at all, unlike individual bookings.
  try {
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
          groupId,
        }),
      });
    }
  } catch (e) {
    console.error("[submitGroupBooking] group sms-confirm dispatch failed", e);
  }

  return {
    ok: true,
    groupId,
    bookingIds: bookingIdList,
    pricing: authoritativePricing,
    cardManagementToken: publicCardManagementToken,
    cardManagementPending: publicCardManagementPending,
  };
}

export async function submitGroupBooking(
  params: GroupBookingParams,
  trustedExecution?: TrustedGroupBookingExecution,
): Promise<GroupBookingResult> {
  return runBookingOrchestrator(
    {
      gateway: params.bookingChannel === "desk" ? "desk" : "online",
      intent: "group",
      operation: "commit",
    },
    (route) => executeGroupBooking(
      {
        ...params,
        bookingChannel: route.channel === "desk" ? "desk" : "online",
      },
      trustedExecution,
    ),
  );
}
