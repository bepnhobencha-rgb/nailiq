import * as Sentry from "@sentry/nextjs";
import {
  ConflictCheckBooking,
  checkBookingConflict,
} from "@/shared/lib/conflictCheck";
import { assertBookingLimitAvailable } from "@/shared/booking/assertBookingLimit";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { salonDayRangeUtc, salonToday, salonWallTimeToUtcIso } from "@/shared/lib/salonTime";
import { createClient } from "@/shared/lib/supabase/client";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import { hmToMinutes } from "@/shared/booking/hmToMinutes";
import { dayKeyFromLocalDate } from "@/shared/booking/dayKeyFromDate";

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
  /** YYYY-MM-DD in salon-local time (not UTC). */
  date: string;
  /** HH:MM (24h) in salon-local time. */
  time: string;
  /** Phase 6.1 — wave this member belongs to (1 for normal bookings). */
  waveNumber?: number;
  /** Add-on service IDs selected for this member. Stored via
   *  `add_booking_addons` RPC after the booking row is created.
   *  Sequential add-ons extend the end_time; concurrent add-ons
   *  add price but +0 time. Prices/durations are re-derived
   *  server-side from the DB. */
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
};

export type GroupBookingResult =
  | { ok: true; groupId: string; bookingIds: string[] }
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
        // Task #04-C FIX 12 — staff was deleted / inactivated
        // between the user picking an arrangement and submitting.
        // Recoverable by re-running the scheduler.
        | "staff_unavailable"
        // Task #04-C FIX 13 — service was soft-deleted between
        // step 2 and submit. Recoverable only by sending the user
        // back to step 2 to pick a different service.
        | "service_unavailable"
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
  if (!Array.isArray(params.members) || params.members.length < 2 || params.members.length > 20) {
    return fail("invalid_group_size");
  }
  if (typeof params.idempotencyKey !== "string" || params.idempotencyKey.trim().length === 0) {
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

  const supabase = createClient();

  // 2. Salon ---------------------------------------------------------
  // `profile_complete` is the single source of truth for "salon
  // accepting bookings" (see submitPublicBooking.ts:173 and
  // loadBookingServices.ts where `acceptingBookings` is derived
  // from this column).
  const { data: salonRaw, error: salonErr } = await supabase
    .from("salons")
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
    if (
      e instanceof Error &&
      e.message === "monthly_booking_limit_reached"
    ) {
      return fail("monthly_booking_limit_reached");
    }
    throw e;
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
  const serviceIds = Array.from(new Set(params.members.map((m) => m.serviceId)));

  // Union add-on ids so we can fetch all in one query.
  const addonIdSet = new Set<string>();
  for (const m of params.members) {
    for (const aid of m.addonServiceIds ?? []) {
      if (aid) addonIdSet.add(aid);
    }
  }
  const allFetchIds = Array.from(new Set([...serviceIds, ...addonIdSet]));

  const { data: services, error: svcErr } = await supabase
    .from("services")
    .select("id, name, duration_minutes, buffer_minutes, price_cents, is_addon, addon_timing")
    .in("id", allFetchIds)
    .eq("salon_id", salonRow.id)
    .is("deleted_at" as never, null);
  if (svcErr) return fail("server_error");

  const serviceById = new Map<string, {
    id: string;
    duration: number;
    buffer: number;
    priceCents: number | null;
  }>();
  // addonById: is_addon rows only — block + priceCents + concurrent flag.
  type AddonInfo = { block: number; priceCents: number | null; concurrent: boolean };
  const addonById = new Map<string, AddonInfo>();

  for (const s of services ?? []) {
    const sTyped = s as typeof s & { is_addon?: unknown; addon_timing?: unknown };
    const isAddon = sTyped.is_addon === true;
    if (isAddon) {
      const block = serviceBlockMinutes(s.duration_minutes, s.buffer_minutes);
      addonById.set(String(s.id), {
        block,
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
    .from("staff")
    .select("id")
    .in("id", staffIds)
    .eq("salon_id", salonRow.id)
    .eq("status", "active")
    .is("deleted_at" as never, null);
  if (staffErr) return fail("server_error");
  const staffSet = new Set((staffRows ?? []).map((s) => String(s.id)));
  // Task #04-C FIX 12 — pinpoint which member's preferred staff
  // disappeared between arrangement-pick and submit. The select
  // above filtered `status='active'` + `deleted_at IS NULL`, so a
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
    durationMin: number;
    bufferMin: number;
    priceCents: number | null;
    addonPriceCents: number | null;
    /** First add-on id for the legacy addon_service_id column. */
    firstAddonId: string | null;
  };
  const resolved: Resolved[] = [];
  for (const m of params.members) {
    const svc = serviceById.get(m.serviceId)!;

    // Add-on resolution: sum sequential block minutes + prices.
    // Invalid / non-is_addon IDs are silently skipped (don't hard-fail).
    let addonBlockMin = 0;
    let addonPriceCentsSum = 0;
    let hasAddonPrice = false;
    let firstAddonId: string | null = null;
    for (const aid of m.addonServiceIds ?? []) {
      const addon = addonById.get(aid);
      if (!addon) continue; // not is_addon for this salon — skip
      if (firstAddonId === null) firstAddonId = aid;
      if (!addon.concurrent) addonBlockMin += addon.block;
      if (addon.priceCents != null) {
        addonPriceCentsSum += addon.priceCents;
        hasAddonPrice = true;
      }
    }

    const totalMin = svc.duration + svc.buffer + addonBlockMin;
    const startMinutes = parseHmToMinutes(m.time)!;
    const startUtcIso = salonWallTimeToUtcIso(m.date, startMinutes, timezone);
    const startMs = Date.parse(startUtcIso);
    const endMs = startMs + totalMin * 60_000;

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
      durationMin: svc.duration,
      bufferMin: svc.buffer,
      priceCents: effectivePriceCents,
      addonPriceCents: hasAddonPrice ? addonPriceCentsSum : null,
      firstAddonId,
    });
  }

  // 5.5. Opening-hours guard — each member's slot must fall within the
  // salon's open window. The group scheduler enforces this on the read
  // path, but a crafted payload could bypass it entirely.
  const openingWeek = parseOpeningHours(salonRow.opening_hours);
  if (openingWeek) {
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      const [y, mo, d] = r.member.date.split("-").map(Number);
      const localDate = new Date(y!, (mo ?? 1) - 1, d ?? 1);
      const dayKey = dayKeyFromLocalDate(localDate);
      const dayHours = dayKey ? openingWeek[dayKey] : null;
      if (!dayHours || dayHours.closed) return fail("salon_closed_day");
      const openM = hmToMinutes(dayHours.open);
      const closeM = hmToMinutes(dayHours.close);
      if (openM === null || closeM === null) continue;
      const startM = parseHmToMinutes(r.member.time)!;
      // Only the SERVICE must finish by close; the trailing buffer (reset gap
      // for the next booking) may run past close for the last appointment.
      const serviceEndM = startM + r.durationMin;
      if (startM < openM || serviceEndM > closeM) {
        return fail("invalid_time", i + 1);
      }
    }
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
      addon_price_cents: r.addonPriceCents,
      wave_number: r.member.waveNumber ?? 1,
      // Couple/group "seat next to each other" preference. Persisted
      // inside the SECURITY DEFINER RPC (the anon client can't UPDATE
      // bookings under RLS). COALESCE default false in the RPC.
      seat_together: params.seatTogether === true,
      staff_requested_by_client: true,
      idempotency_key: idem,
      // Language the organizer was browsing in — persisted on every member row
      // so each guest's transactional SMS matches it. Read by the RPC as a
      // jsonb key; absent/null → column stays null and the SMS sender falls
      // back to customer_preferences.
      client_locale: params.language ?? null,
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
    const { data: otpRow } = await supabase
      .from("phone_otp_sessions")
      .select("id, phone")
      .eq("id", sessionId)
      .eq("salon_id", String(salonRow.id))
      .maybeSingle();
    if (!otpRow) return fail("otp_invalid");
    if (!leadDigits || (otpRow as { phone?: string }).phone !== leadDigits) {
      return fail("otp_invalid");
    }
    otpToConsume = sessionId;
  }

  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    "insert_group_bookings",
    { p_bookings: payload },
  );

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

  const result = rpcData as
    | {
        success?: boolean;
        code?: string;
        group_id?: string;
        booking_ids?: string[];
      }
    | null;
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
    if (code === "invalid_group_size") return fail("invalid_group_size");
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

  // Owner/admin "new booking" alert — one email for the whole party (first
  // booking id). Opt-in, fire-and-forget.
  {
    const firstId = result.booking_ids.map(String)[0];
    if (firstId) {
      void sendOwnerBookingNotification({
        salonId: String(salonRow.id),
        bookingId: firstId,
        event: "new",
        groupSize: result.booking_ids.length,
      });
    }
  }

  // Identity Layer: the client_profiles resolve (per-member, dedup by phone,
  // placeholder-name guard, visit_count bump, FK stamp) now happens INSIDE
  // insert_group_bookings via resolve_client_profile() — atomic + server-
  // authoritative. The old best-effort browser upsert was removed (migration
  // 20260614110000); under RLS it could silently no-op, and members without
  // their own phone (party members) must NOT get a profile keyed to the
  // organizer's number. Keeping it here would also double-count visits.

  // Task #04-D FIX 02 — atomic-rollback observability. The RPC
  // is wrapped in a single PL/pgSQL transaction so the only ways
  // we should see a length mismatch here are:
  //   (a) the RPC was redeployed with a different contract and
  //       the client didn't get the version bump, or
  //   (b) a future RPC author breaks atomicity (e.g. catches a
  //       per-row exception inside the loop).
  // Both are silent-data-loss bugs from the customer's POV —
  // they see "booking confirmed for 4" but only 3 rows exist.
  // Sentry capture surfaces the drift; we still return ok so the
  // confirmation page renders for the rows that did land.
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
  }

  // Persist itemized add-ons per member — best-effort, exactly like
  // submitPublicBooking. Prices/durations re-derived server-side
  // inside the SECURITY DEFINER RPC; failure only loses the
  // itemized breakdown, not the booking itself.
  const bookingIdList = result.booking_ids.map((s) => String(s));
  // NOTE: no-show card flagging for the GROUP lead is done server-side in
  // createDeskGroup (desk path); this function also runs in the browser
  // (online group wizard) so it must NOT import the server-only gate here.

  // Group committed — now single-use-consume the OTP session (fire-and-forget).
  // Relative URL only resolves in the browser; server callers (desk flow)
  // need an absolute URL or this silently no-ops (session stays unconsumed).
  if (otpToConsume) {
    const consumeAppUrl =
      typeof window !== "undefined"
        ? ""
        : (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
    void fetch(`${consumeAppUrl}/api/booking-otp/consume-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: otpToConsume }),
    });
  }

  await Promise.all(
    params.members.map(async (m, i) => {
      const addonIds = (m.addonServiceIds ?? []).filter((aid) => addonById.has(aid));
      if (addonIds.length === 0) return;
      const bookingId = bookingIdList[i];
      if (!bookingId) return;
      try {
        await supabase.rpc("add_booking_addons", {
          p_booking_id: bookingId,
          p_service_ids: addonIds,
        });
      } catch (e) {
        console.error("[submitGroupBooking] add_booking_addons failed for member", i, e);
      }
    }),
  );

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
          : (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
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

  // Fire-and-forget: redeem the party voucher against the lead booking. The
  // voucher is tied to the organizer's phone (only member 0 has a real number)
  // and applies to the whole-party total, so it redeems once against the lead
  // row — mirrors submitPublicBooking's redeem side-effect.
  if (params.voucherRedemption?.voucher_id && bookingIdList[0]) {
    const organizerPhoneOk = validateGuestPhone(params.members[0]?.phone ?? "");
    if (organizerPhoneOk.ok) {
      const groupTotalCents = resolved.reduce(
        (sum, r) => sum + (r.priceCents ?? 0) + (r.addonPriceCents ?? 0),
        0,
      );
      void (async () => {
        try {
          const appUrl =
            typeof window !== "undefined"
              ? ""
              : (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
          await fetch(`${appUrl}/api/vouchers/redeem`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              voucher_id: params.voucherRedemption!.voucher_id,
              salon_id: String(salonRow.id),
              client_phone: organizerPhoneOk.digits,
              booking_id: bookingIdList[0],
              original_price_cents: groupTotalCents,
              discount_cents: params.voucherRedemption!.discount_cents,
            }),
          });
        } catch (e) {
          console.error("[submitGroupBooking] voucher redeem dispatch failed", e);
        }
      })();
    }
  }

  return {
    ok: true,
    groupId: result.group_id,
    bookingIds: bookingIdList,
  };
}
