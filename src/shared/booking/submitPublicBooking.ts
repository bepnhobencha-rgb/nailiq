import * as Sentry from "@sentry/nextjs";
import { assertBookingLimitAvailable } from "@/shared/booking/assertBookingLimit";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import {
  computeBookingTiming,
  type BookingTimingSegment,
} from "@/shared/booking/bookingTiming";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { parseTimeSlotToMinutes } from "@/shared/booking/parseBookingTimeSlot";
import { hmToMinutes } from "@/shared/booking/hmToMinutes";
import { dayKeyFromLocalDate } from "@/shared/booking/dayKeyFromDate";
import { salonWallTimeToUtcIso } from "@/shared/lib/salonTime";
import { pickBestStaffAmongFree } from "@/shared/booking/pickBestStaffAmongFree";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import {
  buildCapabilityMap,
  filterStaffCapableForServices,
} from "@/shared/booking/staffCapability";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { createPublicClient } from "@/shared/lib/supabase/publicClient";
import { runPublicBookingSideEffects } from "@/shared/booking/publicBookingSideEffects";
import { saveNoShowCardAction, reuseNoShowCardAction } from "@/shared/noshow/saveNoShowCardAction";
import { computeTax } from "@/shared/tax/computeTax";
import type { TaxLine } from "@/shared/tax/taxTypes";
import { healthAckRequired } from "@/shared/lib/healthAck";

export type BookingParams = {
  shopSlug: string;
  serviceId: string;
  /** Same localized labels produced by `getAvailableTimeSlots` (e.g. `"9:00 AM"`). */
  timeSlot: string;
  /** Local calendar day `YYYY-MM-DD` for the appointment (guest timezone). */
  bookingDateYmd: string;
  /** `"any"` or the salon staff UUID. */
  staffId: string;
  clientName: string;
  clientPhone: string;
  /** Optional — empty string / undefined skips it. Format-checked when present (B-10). */
  clientEmail?: string | null;
  clientNotes?: string;
  /** Optional add-on booked into the same row (pre-confirm upsell with real float only). */
  addonServiceId?: string | null;
  /** Multiple add-ons (review-step upsell). Takes precedence over `addonServiceId`
   *  when non-empty. Each must be an `is_addon` service of this salon; durations
   *  sum into the booking block and must fit the staff's free gap. */
  addonServiceIds?: readonly string[] | null;
  /** SMS OTP session ID from `/api/booking-otp/verify`. Required only
   *  when the salon has `phone_otp_enabled = true`. */
  otpSessionId?: string | null;
  /** Task #09-11 honeypot. Empty for real users (the HTML field is
   *  hidden, `tabIndex=-1`, and `aria-hidden`). Bots autofilling
   *  every input populate this — `submitPublicBooking` short-circuits
   *  with a fake-success when it's non-empty so no row is written
   *  and the bot doesn't learn it was detected. */
  clientWebsite?: string;
  /** Voucher to redeem after booking is confirmed (fire-and-forget). */
  voucherRedemption?: { voucher_id: string; discount_cents: number } | null;
  /** Reference inspiration image path in Supabase Storage (fire-and-forget). */
  referenceImagePath?: string | null;
  /** Smart verification method used for this booking (from verify-decision flow). */
  verificationMethod?: "none" | "otp" | "deposit" | "vip_skip" | null;
  /** Combo bundle selected by the customer — overrides service duration and price. */
  comboOverride?: {
    comboId: string;
    durationMinutes: number;
    priceCents: number;
  } | null;
  /** Referral code from `/<slug>?ref=CODE` — links this booking to a referral so
   *  both parties get a reward voucher when the booking completes. Best-effort. */
  referralCode?: string | null;
  /** Booking-surface language. Forwarded to the confirmation SMS so it's
   *  sent in the language the customer chose (defaults to vi server-side). */
  language?: "en" | "vi";
  /** Option A no-show card gate: Web Payments SDK card token captured IN the
   *  confirm step. When present, the card is saved server-side right after the
   *  booking is created and BEFORE any confirmation (SMS/email) — if the save
   *  fails the booking is cancelled and the customer sees an error. */
  noShowCardSourceId?: string | null;
  /** SCA/AVS/CVV verification token (Square `verifyBuyer`) paired with
   *  `noShowCardSourceId`. Passed to CreateCard so Square verifies the card at
   *  storage time (rejects a wrong CVV/postal). */
  noShowCardVerificationToken?: string | null;
  /** Option A reuse path: returning OTP-verified customer chose to reuse their
   *  EXISTING saved card instead of entering a new one. No card token is sent —
   *  the server re-derives the card from the OTP-verified phone. Ignored if
   *  `noShowCardSourceId` is also present (a new card wins). */
  noShowReuseSavedCard?: boolean;
  /** Customer agreed to the no-show policy + card-on-file authorization. */
  noShowConsent?: boolean;
  /** Customer ticked the mandatory health acknowledgment (massage/head spa/etc).
   *  Stamps bookings.health_ack_at server-side as duty-of-care evidence. */
  healthAck?: boolean;
  /** Customer opted into marketing communications (win-back, rebook, VIP Care,
   *  first-visit nurture). Stamps client_profiles.marketing_consent_at so Minh
   *  agents can contact them. NULL / false = no consent → agents skip. */
  marketingConsent?: boolean;
  /** The customer ticked the required SMS-consent box. Only the browser flow can
   *  assert this; server-side callers (desk, voice) leave it unset so no consent
   *  record is fabricated for a customer who never saw a checkbox. */
  smsConsent?: boolean;
  /** Active promotion to apply after booking is confirmed (fire-and-forget server action). */
  promoRedemption?: { promoId: string; discountCents: number } | null;
  /** Email capture: $2 off incentive for first-time email submission. */
  emailCaptureDiscount?: boolean;
};

export type BookingResult = {
  bookingId: string;
  serviceName: string;
  startTimeUtc: string;
  endTimeUtc: string;
  status: "confirmed";
  price_cents: number;
  staffName: string;
  /** First add-on name (legacy/back-compat — prefer `addons`). */
  addonServiceName: string | null;
  /** Sum of all add-on prices (legacy/back-compat — prefer `addons`). */
  addonPriceCents: number | null;
  /** All add-ons booked into this row (itemized for the success/done view). */
  addons: { serviceId: string; name: string; priceCents: number | null }[];
};

export class BookingConflictError extends Error {
  constructor() {
    super("time_slot_taken");
    this.name = "BookingConflictError";
  }
}

type RpcErrorShape = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

/** Reports Postgres RPC / PostgREST failures so Sentry sees them even when the UI swallows the thrown Error client-side. */
function captureCreatePublicBookingFailure(params: {
  reason: string;
  rpcError?: RpcErrorShape | null;
  rpcJsonBody?: unknown;
}) {
  const base =
    params.rpcError?.message?.trim() ||
    `create_public_booking (${params.reason})`;
  const err = new Error(base);
  err.name = "CreatePublicBookingRpcError";
  Sentry.captureException(err, {
    tags: {
      "booking.rpc": "create_public_booking",
      "booking.rpc.failure": params.reason,
    },
    contexts: {
      nailiq_rpc: {
        reason: params.reason,
        supabase: params.rpcError ?? null,
        rpc_json_preview:
          params.rpcJsonBody !== undefined
            ? JSON.stringify(params.rpcJsonBody).slice(0, 2000)
            : undefined,
      },
    },
  });
}

function localDateYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localDayBoundsFromYmd(dateYmd: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const start = new Date(y, mo - 1, d, 0, 0, 0, 0);
  const end = new Date(y, mo - 1, d, 23, 59, 59, 999);
  if (Number.isNaN(start.getTime())) return null;
  return { start, end };
}

type OccInterval = {
  staffId: string;
  startMs: number;
  endMs: number;
};

export async function submitPublicBooking(
  params: BookingParams,
): Promise<BookingResult> {
  const {
    shopSlug,
    serviceId,
    timeSlot,
    bookingDateYmd,
    staffId: requestedStaffId,
    clientName,
    clientPhone,
    clientNotes = "",
    addonServiceId = null,
    addonServiceIds = null,
    comboOverride = null,
  } = params;

  // Normalize to a de-duplicated list of add-on ids: the multi-select list
  // (review step) takes precedence; fall back to the legacy single id.
  const addonIds: string[] = (() => {
    const arr =
      addonServiceIds && addonServiceIds.length > 0
        ? addonServiceIds
        : addonServiceId
          ? [addonServiceId]
          : [];
    return Array.from(new Set(arr.map((s) => String(s)).filter(Boolean)));
  })();

  const bookingScope = Sentry.getCurrentScope();
  bookingScope.setTag("booking.flow", "submit_public_booking");
  bookingScope.setTag("salon.slug", shopSlug);

  // Task #09-11 — honeypot guard. The `clientWebsite` field is
  // hidden in the DOM (display:none + aria-hidden + tabIndex=-1) so
  // a real user never fills it. Naive form-stuffer bots populate
  // every `<input>` and trip this branch. Return a fake-but-shape-
  // valid BookingResult so the UI shows a normal success page;
  // no DB row is written. Sentry tags the hit so we can monitor
  // abuse without blocking on it.
  if ((params.clientWebsite ?? "").trim().length > 0) {
    Sentry.captureMessage("booking honeypot tripped", {
      level: "info",
      tags: {
        "booking.flow": "submit_public_booking",
        "booking.honeypot": "tripped",
        "salon.slug": shopSlug,
      },
    });
    const nowIso = new Date().toISOString();
    return {
      bookingId: `bot-${Date.now()}`,
      serviceName: "",
      startTimeUtc: nowIso,
      endTimeUtc: nowIso,
      status: "confirmed",
      price_cents: 0,
      staffName: "",
      addonServiceName: null,
      addonPriceCents: null,
      addons: [],
    };
  }

  const phoneOk = validateGuestPhone(clientPhone);
  if (!phoneOk.ok) {
    throw new Error("invalid_phone");
  }

  const nameTrimmed = clientName.trim();
  if (!isValidCustomerName(nameTrimmed)) {
    throw new Error("invalid_name_chars");
  }

  /** B-10: optional. Empty / undefined → null in DB. Provided-but-malformed → throw. */
  const emailRaw = (params.clientEmail ?? "").trim();
  const emailToStore: string | null =
    emailRaw.length === 0
      ? null
      : isValidEmailFormat(emailRaw)
        ? emailRaw
        : (() => {
            throw new Error("invalid_email");
          })();

  const supabase = createPublicClient();

  const { data: salonData, error: salonErr } = await supabase
    .from("public_salon_profiles" as never)
    .select(
      "id, profile_complete, opening_hours, subscription_plan, plan_override, feature_flags, phone_otp_enabled, booking_lead_minutes, timezone, tax_lines, vertical, health_ack_required",
    )
    .eq("slug", shopSlug)
    .single();

  if (salonErr || !salonData) throw new Error("salon_not_found");
  const salon = salonData as unknown as {
    id: string;
    profile_complete?: boolean | null;
    opening_hours?: unknown;
    subscription_plan?: string | null;
    plan_override?: string | null;
    feature_flags?: Record<string, unknown> | null;
    phone_otp_enabled?: boolean | null;
    booking_lead_minutes?: number | null;
    timezone?: string | null;
    tax_lines?: unknown;
    vertical?: string | null;
    health_ack_required?: boolean | null;
  };

  bookingScope.setTag("salon.id", String(salon.id));
  bookingScope.setContext("salon", {
    id: String(salon.id),
    slug: shopSlug,
  });

  if (!salon.profile_complete) throw new Error("salon_not_live");

  // Server-side enforce the health acknowledgment for verticals/salons that
  // require it. The booking panel already gates the tick client-side, but this
  // runs with the anon key, so a hand-crafted request must not slip through
  // required-but-unticked (the tick is legal evidence, not just UX).
  if (
    healthAckRequired(
      (salon as { health_ack_required?: boolean | null }).health_ack_required,
      (salon as { vertical?: string | null }).vertical,
    ) &&
    params.healthAck !== true
  ) {
    throw new Error("health_ack_required");
  }

  // Validate OTP session when the salon requires phone verification.
  // Note: submitPublicBooking runs in the browser (no "use server"). Validate
  // the exact capability through a boolean RPC; OTP rows and phone numbers are
  // never readable by the anonymous client.
  const salonPhoneOtpEnabled =
    (salon as { phone_otp_enabled?: unknown }).phone_otp_enabled === true;
  // The OTP session id actually used downstream (reuse + consume). Resolved from
  // the client-passed id OR a valid session for the phone (see fallback below).
  let resolvedOtpSessionId = "";
  if (salonPhoneOtpEnabled) {
    const passedId = (params.otpSessionId ?? "").trim();
    if (!passedId) throw new Error("otp_required");
    const { data: otpValid, error: otpValidationError } = await supabase.rpc(
      "validate_phone_otp_session" as never,
      {
        p_session_id: passedId,
        p_salon_id: String(salon.id),
        p_phone: phoneOk.digits,
      } as never,
    );
    if (otpValidationError || otpValid !== true) {
      throw new Error("otp_required");
    }
    resolvedOtpSessionId = passedId;

    // NOTE: do NOT consume the session here. The saved-card REUSE path
    // (reuseNoShowCardForBooking, below) re-validates this same session and
    // requires it UNCONSUMED to re-derive the card by the verified phone.
    // Consume happens at the END, after the card step (single-use still holds).
  }

  // Enforce per-plan monthly booking cap (landing-page promise).
  // Throws `monthly_booking_limit_reached` for the form to surface.
  const planFields = salon as {
    subscription_plan?: string | null;
    plan_override?: string | null;
    feature_flags?: Record<string, unknown> | null;
  };
  await assertBookingLimitAvailable(supabase, {
    id: String(salon.id),
    subscription_plan: planFields.subscription_plan,
    plan_override: planFields.plan_override,
    feature_flags: planFields.feature_flags,
  });

  const closedYmdSet = parseBookingClosedDateSet(
    (salon as { booking_closed_dates?: unknown }).booking_closed_dates,
  );
  if (closedYmdSet.has(bookingDateYmd.trim())) {
    throw new Error("salon_closed_day");
  }

  const week = parseOpeningHours((salon as { opening_hours?: unknown }).opening_hours);
  if (!week) throw new Error("salon_hours_invalid");

  const { data: service, error: serviceErr } = await supabase
    .from("public_service_catalog")
    .select("id, name, duration_minutes, buffer_minutes, price_cents")
    .eq("id", serviceId)
    .eq("salon_id", salon.id)
    .single();

  if (serviceErr || !service) throw new Error("service_not_found");

  const dayBounds = localDayBoundsFromYmd(bookingDateYmd);
  if (!dayBounds) throw new Error("invalid_booking_date");

  const todayYmd = localDateYmd(new Date());
  if (bookingDateYmd < todayYmd) {
    throw new Error("cannot_book_past");
  }

  // Resolve the chosen slot in the SALON's timezone (not the customer's device
  // tz), so a slot labelled "2:00 PM" is always 2 PM at the salon. `startLocal`
  // holds the resulting absolute instant — every downstream .getTime()/
  // .toISOString() stays correct.
  const salonTz =
    String((salon as { timezone?: unknown }).timezone ?? "").trim() ||
    "America/Los_Angeles";
  let startLocal: Date;
  let startMinsOfDay: number;
  try {
    startMinsOfDay = parseTimeSlotToMinutes(timeSlot);
    startLocal = new Date(
      Date.parse(salonWallTimeToUtcIso(bookingDateYmd, startMinsOfDay, salonTz)),
    );
    if (Number.isNaN(startLocal.getTime())) throw new Error("invalid_time_slot");
  } catch {
    throw new Error("invalid_time_slot");
  }

  const now = new Date();
  // Must match the public slot grid (salons.booking_lead_minutes); a hardcoded
  // 15-min buffer here rejected slots the grid offered when a salon lowered its
  // lead time → "cannot_book_past" bounce. Default 15 when unset.
  const leadMinutesRaw = Number(
    (salon as { booking_lead_minutes?: unknown }).booking_lead_minutes,
  );
  const leadBufferMs =
    (Number.isFinite(leadMinutesRaw) && leadMinutesRaw >= 0
      ? Math.round(leadMinutesRaw)
      : 15) *
    60 *
    1000;
  if (startLocal.getTime() < now.getTime() + leadBufferMs) {
    throw new Error("cannot_book_past");
  }

  // Combo price + duration are SERVER-authoritative: never trust the client's
  // comboOverride. Re-derive both from service_combos (mirrors the add-on
  // pattern) so a tampered client can't book a combo at an arbitrary price.
  let combo: { comboId: string; priceCents: number; durationMinutes: number } | null = null;
  if (comboOverride) {
    const { data: comboRow } = await supabase
      .from("service_combos" as never)
      .select("id, price_cents, duration_minutes")
      .eq("id" as never, comboOverride.comboId)
      .eq("salon_id" as never, salon.id)
      .eq("is_active" as never, true)
      .maybeSingle();
    if (!comboRow) throw new Error("combo_not_found");
    const c = comboRow as { price_cents?: unknown; duration_minutes?: unknown };
    combo = {
      comboId: comboOverride.comboId,
      priceCents: Number(c.price_cents) || 0,
      durationMinutes: Number(c.duration_minutes) || 60,
    };
  }

  const timingAddOns: BookingTimingSegment[] = [];
  type AddonRow = { id: string; name: string; price_cents: number | null };
  const addonRows: AddonRow[] = [];

  if (addonIds.length > 0) {
    if (addonIds.some((id) => id === String(service.id))) {
      throw new Error("invalid_addon");
    }
    // One round-trip for all add-ons; each must belong to the salon, be live,
    // and be flagged is_addon (prices/durations come from the DB, not client).
    const { data: addSvcs, error: addErr } = await supabase
      .from("public_service_catalog")
      .select("id, name, duration_minutes, buffer_minutes, price_cents, is_addon, addon_timing")
      .in("id", addonIds)
      .eq("salon_id", salon.id);

    if (addErr) throw new Error("addon_not_found");
    const byId = new Map(
      (addSvcs ?? []).map((r) => [String((r as { id: string }).id), r]),
    );
    // Preserve the customer's selection order.
    for (const id of addonIds) {
      const addSvc = byId.get(id) as
        | { id: string; name: string; duration_minutes?: unknown; buffer_minutes?: unknown; price_cents?: unknown; is_addon?: unknown; addon_timing?: unknown }
        | undefined;
      if (!addSvc || addSvc.is_addon !== true) throw new Error("addon_not_found");
      const duration = Math.round(Number(addSvc.duration_minutes) || 0);
      const buffer = Math.max(
        0,
        Math.round(Number(addSvc.buffer_minutes) || 0),
      );
      if (duration <= 0) throw new Error("invalid_addon");
      // Concurrent add-ons run alongside the main service → add $0 time to the
      // appointment block; only sequential ones extend the end time.
      timingAddOns.push({
        durationMinutes: duration,
        bufferMinutes: buffer,
        concurrent: addSvc.addon_timing === "concurrent",
      });
      addonRows.push({
        id: String(addSvc.id),
        name: String(addSvc.name ?? ""),
        price_cents: addSvc.price_cents != null ? Number(addSvc.price_cents) : null,
      });
    }
  }

  // First add-on drives the legacy single-value columns; the full list is
  // persisted via `add_booking_addons` after insert.
  const addonRow: AddonRow | null = addonRows[0] ?? null;
  const bookingTiming = computeBookingTiming(
    combo
      ? { durationMinutes: combo.durationMinutes, bufferMinutes: 0 }
      : {
          durationMinutes: service.duration_minutes,
          bufferMinutes: service.buffer_minutes,
        },
    timingAddOns,
  );
  const totalBlockMin = bookingTiming.blockMinutes;
  const endLocal = new Date(startLocal.getTime() + totalBlockMin * 60_000);

  // Opening-hours check in SALON-LOCAL minutes (device-tz-independent). Mirrors
  // assertSlotWithinOpeningHours but works on the wall-clock minutes we already
  // have, avoiding Date.getHours() (which would read the runtime's tz).
  {
    if (!week) throw new Error("outside_opening_hours");
    const dayCfg = week[dayKeyFromLocalDate(new Date(`${bookingDateYmd}T12:00:00`))];
    if (!dayCfg || dayCfg.closed) throw new Error("salon_closed_day");
    const openM = hmToMinutes(dayCfg.open);
    const closeM = hmToMinutes(dayCfg.close);
    const endMinsOfDay = startMinsOfDay + totalBlockMin;
    const serviceEndMinsOfDay =
      startMinsOfDay +
      (combo || addonIds.length > 1
        ? bookingTiming.blockMinutes
        : bookingTiming.serviceCompletionMinutes);
    if (closeM <= openM) throw new Error("outside_opening_hours");
    if (
      startMinsOfDay < openM ||
      serviceEndMinsOfDay > closeM ||
      endMinsOfDay <= startMinsOfDay
    ) {
      throw new Error("outside_opening_hours");
    }
  }

  const priceSnapshot = combo
    ? combo.priceCents
    : service.price_cents != null
      ? Number(service.price_cents)
      : null;
  // Booking row stores the SUM of all add-on prices (null when none priced).
  const addonPriceSnapshot =
    addonRows.length > 0
      ? addonRows.reduce((sum, a) => sum + (a.price_cents ?? 0), 0)
      : null;

  const { data: staffRows, error: staffListErr } = await supabase
    .from("public_staff_profiles")
    .select("id, name")
    .eq("salon_id", salon.id)
    // Only ACTIVE providers are real bookable beds — must match the public
    // slot grid (loadBookingServices) + receptionist grid, both of which
    // filter status='active'. Without this, an inactive row (e.g. a
    // receptionist's auto-created staff row) is counted as an extra bed and
    // the salon gets oversold by one when auto-assigning "Any" staff.
    .eq("status", "active")
    .order("name", { ascending: true });

  if (staffListErr) throw new Error("staff_load_failed");
  const allStaff = (staffRows ?? []).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
  }));
  if (allStaff.length === 0) throw new Error("no_staff_available");

  const { data: capRows } = await supabase
    .from("staff_services")
    .select("staff_id, service_id")
    .in("staff_id", allStaff.map((s) => s.id));
  const capability = buildCapabilityMap(
    (capRows ?? []).map((r) => ({
      staff_id: String(r.staff_id),
      service_id: String(r.service_id),
    })),
  );
  const requiredServiceIds = [
    String(service.id),
    ...addonRows.map((a) => a.id),
  ];
  const orderedStaff = filterStaffCapableForServices(
    allStaff,
    capability,
    requiredServiceIds,
  );
  if (orderedStaff.length === 0) throw new Error("no_staff_available");

  const { data: occRaw, error: occErr } = await supabase.rpc(
    "public_booking_occupancy_for_range",
    {
      p_salon_id: salon.id,
      p_start: dayBounds.start.toISOString(),
      p_end: dayBounds.end.toISOString(),
    },
  );

  let occupancy: OccInterval[] = [];
  if (!occErr && Array.isArray(occRaw)) {
    occupancy = (occRaw as { staff_id: string; start_time_utc: string; end_time_utc: string }[]).map(
      (row) => ({
        staffId: String(row.staff_id),
        startMs: new Date(row.start_time_utc).getTime(),
        endMs: new Date(row.end_time_utc).getTime(),
      }),
    );
  }

  const slotStartMs = startLocal.getTime();
  const slotEndMs = endLocal.getTime();

  function isStaffFreeForRange(
    staffUuid: string,
    rangeStartMs: number,
    rangeEndMs: number,
  ): boolean {
    for (const o of occupancy) {
      if (o.staffId !== staffUuid) continue;
      if (intervalsOverlapMs(rangeStartMs, rangeEndMs, o.startMs, o.endMs)) {
        return false;
      }
    }
    return true;
  }

  let resolvedStaffId: string | null = null;
  let resolvedStaffName = "";

  const dayStartMs = dayBounds.start.getTime();
  const dayEndMs = dayBounds.end.getTime();

  if (requestedStaffId === BOOKING_ANY_STAFF_ID) {
    const freeIds = orderedStaff
      .map((r) => String(r.id))
      .filter((id) => isStaffFreeForRange(id, slotStartMs, slotEndMs));
    if (freeIds.length === 0) throw new BookingConflictError();
    resolvedStaffId = pickBestStaffAmongFree(
      freeIds,
      orderedStaff.map((r) => ({ id: String(r.id), name: String(r.name ?? "") })),
      occupancy,
      dayStartMs,
      dayEndMs,
      slotStartMs,
    );
    const chosen = orderedStaff.find((r) => String(r.id) === resolvedStaffId);
    resolvedStaffName = String(chosen?.name ?? "");
  } else {
    const allowed = orderedStaff.some(
      (r) => String(r.id) === requestedStaffId,
    );
    if (!allowed) throw new Error("invalid_staff");

    if (!isStaffFreeForRange(requestedStaffId, slotStartMs, slotEndMs)) {
      throw new BookingConflictError();
    }

    resolvedStaffId = requestedStaffId;
    const chosen = orderedStaff.find((r) => String(r.id) === requestedStaffId);
    resolvedStaffName = String(chosen?.name ?? "");
  }

  // Wix availability guard — only for Wix-connected salons with a mapped staff resource.
  // Queries the server-side API route which uses WIX_API_KEY to call Wix Extended Bookings
  // and detect overlapping active bookings created on Wix since the last 2-min cron poll.
  // Fail-open: if the API call fails or times out, booking proceeds normally.
  if (resolvedStaffId) {
    try {
      const wixCheckRes = await fetch("/api/booking/wix-conflict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salonId: String(salon.id),
          staffId: resolvedStaffId,
          startTimeUtc: startLocal.toISOString(),
          endTimeUtc: endLocal.toISOString(),
        }),
        signal: AbortSignal.timeout(5000), // 5s max — never stall the booking flow
      });
      if (wixCheckRes.ok) {
        const wixCheckData = (await wixCheckRes.json()) as { conflict?: boolean };
        if (wixCheckData.conflict === true) {
          throw new BookingConflictError();
        }
      }
    } catch (e) {
      // Re-throw BookingConflictError — it is intentional.
      if (e instanceof BookingConflictError) throw e;
      // Any other error (network, timeout, parse failure) → fail open.
    }
  }

  const notesTrim = clientNotes.trim();
  const insertPayload = {
    salon_id: salon.id as string,
    service_id: service.id as string,
    staff_id: resolvedStaffId,
    client_name: nameTrimmed,
    client_phone: phoneOk.digits,
    client_email: emailToStore,
    client_notes: notesTrim.length > 0 ? notesTrim : null,
    start_time_utc: startLocal.toISOString(),
    end_time_utc: endLocal.toISOString(),
    status: "confirmed" as const,
    price_cents: priceSnapshot,
    addon_service_id:
      addonRow ? addonRow.id : null,
    addon_price_cents: addonRow ? addonPriceSnapshot : null,
  };

  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    "create_public_booking",
    {
      p_salon_id: insertPayload.salon_id,
      p_service_id: insertPayload.service_id,
      p_staff_id: insertPayload.staff_id,
      p_client_name: insertPayload.client_name,
      p_client_phone: insertPayload.client_phone,
      p_start_time_utc: insertPayload.start_time_utc,
      p_end_time_utc: insertPayload.end_time_utc,
      p_status: insertPayload.status,
      p_price_cents: insertPayload.price_cents,
      p_client_notes: insertPayload.client_notes,
      p_addon_service_id: insertPayload.addon_service_id,
      p_addon_price_cents: insertPayload.addon_price_cents,
      p_client_email: insertPayload.client_email,
    },
  );

  let bookingId = "";

  if (!rpcErr && rpcData != null) {
    const raw = Array.isArray(rpcData) ? rpcData[0] : rpcData;
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      if (o.success === false) {
        const code = typeof o.code === "string" ? o.code : "";
        if (code === "slot_conflict" || code === "duplicate_booking") {
          throw new BookingConflictError();
        }
        if (code === "rate_limited") {
          throw new Error("booking_rate_limited");
        }
        captureCreatePublicBookingFailure({
          reason: code ? `json_error_${code}` : "json_success_false",
          rpcJsonBody: raw,
        });
        throw new Error(code ? `booking_rpc_${code}` : "booking_rpc_failed");
      }
      if (
        o.success === true &&
        typeof o.booking_id === "string" &&
        o.booking_id.length > 0
      ) {
        bookingId = o.booking_id;
      } else if (
        !("success" in o) &&
        typeof (o as { id?: unknown }).id === "string" &&
        (o as { id: string }).id.length > 0
      ) {
        /* Older create_public_booking returning (id, status); remove once migration is universal. */
        bookingId = (o as { id: string }).id;
      }
    }
  }

  const rpcMissing =
    rpcErr &&
    (rpcErr.code === "PGRST202" ||
      String(rpcErr.message ?? "").includes("Could not find the function"));

  // Customer specifically requested this staff (anything other than
  // the "any" sentinel). Drives the ❤️ icon on booking chips and the
  // "Khách yêu cầu thợ này" line in the drawer.
  const customerRequestedStaff =
    requestedStaffId !== BOOKING_ANY_STAFF_ID;

  if (!bookingId && rpcMissing) {
    // Task #09-A: the fallback `from("bookings").insert(...)` path
    // was retired. Anon INSERTs into `public.bookings` are now hard
    // -denied by RLS (`bookings_insert_anon` policy → with check
    // (false)), so the only safe write path is the SECURITY DEFINER
    // RPC. If the RPC is missing in prod, fail loudly — silently
    // bypassing app-layer validation (staff↔salon correlation,
    // opening hours, lead-time, capability) is worse than a
    // user-visible error.
    captureCreatePublicBookingFailure({
      reason: "rpc_missing_no_fallback",
      rpcError: rpcErr ?? null,
    });
    throw new Error(
      "create_public_booking RPC is required — direct booking insert is disabled",
    );
  }

  if (!bookingId) {
    if (rpcErr) {
      if (rpcErr.code === "23505") throw new BookingConflictError();
      if (rpcErr.code === "23P01") throw new BookingConflictError(); // overlap / exclusion
      if (rpcErr.message?.includes("invalid_addon_service")) {
        captureCreatePublicBookingFailure({
          reason: "invalid_addon_service",
          rpcError: rpcErr,
        });
        throw new Error("invalid_addon");
      }
      captureCreatePublicBookingFailure({
        reason: "supabase_rpc_error",
        rpcError: rpcErr,
      });
      throw new Error(rpcErr.message);
    }
    captureCreatePublicBookingFailure({ reason: "booking_rpc_empty" });
    throw new Error("booking_rpc_empty");
  }

  // Option A no-show card gate: a required-card booking captured the card IN the
  // confirm step. Save it NOW — before any confirmation goes out. On failure we
  // do NOT throw / cancel: a card glitch (Square lookup miss, network, declined
  // verification) must never cost a real customer their slot. The action keeps
  // the booking + flags `noshow_card_required` so the desk collects a card later
  // (the "⚠️ needs card" badge). Booking proceeds; protection is desk-recoverable.
  if (params.noShowCardSourceId && bookingId) {
    const saved = await saveNoShowCardAction({
      bookingId,
      sourceId: params.noShowCardSourceId,
      consent: params.noShowConsent === true,
      verificationToken: params.noShowCardVerificationToken ?? undefined,
    });
    if (!saved.ok) {
      console.error("[submitPublicBooking] card save failed — booking kept + flagged:", saved.reason, bookingId);
    }
  } else if (params.noShowReuseSavedCard && bookingId) {
    // Returning OTP-verified customer reused their existing card on file. Same
    // non-fatal contract — a reuse glitch flags the booking, never cancels it.
    const reused = await reuseNoShowCardAction({
      bookingId,
      otpSessionId: resolvedOtpSessionId,
      consent: params.noShowConsent === true,
    });
    if (!reused.ok) {
      console.error("[submitPublicBooking] card reuse failed — booking kept + flagged:", reused.reason, bookingId);
    }
  }

  // Finalize identity evidence only after the card/reuse step, which needs the
  // OTP session unconsumed. The narrow RPC binds the unguessable booking id to
  // its durable client_profile_id, validates the exact OTP salon+phone, stamps
  // phone trust / marketing consent and consumes OTP in one transaction.
  if (resolvedOtpSessionId || params.marketingConsent === true) {
    const { data: finalized, error: finalizeError } = await supabase.rpc(
      "finalize_public_booking_profile" as never,
      {
        p_booking_id: bookingId,
        p_otp_session_id: resolvedOtpSessionId || null,
        p_marketing_consent: params.marketingConsent === true,
      } as never,
    );
    const result = finalized as
      | { success?: boolean; code?: string }
      | null;
    if (finalizeError || result?.success !== true) {
      const err = new Error(
        finalizeError?.message ??
          `profile_finalize_${result?.code ?? "failed"}`,
      );
      err.name = "PublicBookingProfileFinalizeError";
      Sentry.captureException(err, {
        tags: {
          "booking.rpc": "finalize_public_booking_profile",
          "booking.rpc.failure": "profile_finalize_best_effort",
        },
        extra: {
          code: result?.code ?? null,
          message: finalizeError?.message ?? null,
        },
      });

      // Fail closed on OTP replay even during a brief code-before-migration
      // deployment window. The booking remains committed; only the durable
      // trust stamp is deferred.
      if (resolvedOtpSessionId) {
        void fetch("/api/booking-otp/consume-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: resolvedOtpSessionId }),
        });
      }
    }
  }

  // booking_channel='online' + client_locale are stamped SERVER-SIDE in
  // runPublicBookingSideEffects below. The RPC leaves booking_channel null, and
  // a browser anon `.update()` silently no-ops (UPDATE grant but no RLS UPDATE
  // policy → 0 rows, no error), which is why every online booking saved as
  // null channel. Reports use the channel; the SMS sender uses client_locale.
  // The owner/admin "new booking" alert is dispatched from
  // runPublicBookingSideEffects below, NOT here: this function runs in the
  // browser, where sendOwnerBookingNotification's createServiceRoleClient()
  // throws and its catch swallows the failure — every online booking silently
  // produced no owner alert. Same trap as the confirmation email before it.

  const totalPriceCents =
    (priceSnapshot ?? 0) + (addonPriceSnapshot ?? 0);

  const salonTaxLines: TaxLine[] = (() => {
    const raw = (salon as { tax_lines?: unknown }).tax_lines;
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[])
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
      .map((item) => ({
        name: typeof item.name === "string" ? item.name : "",
        rate: typeof item.rate === "number" ? item.rate : 0,
        enabled: item.enabled !== false,
      }))
      .filter((l) => l.name.length > 0);
  })();
  const taxResult = computeTax(totalPriceCents, salonTaxLines);

  // Persist the itemized add-on list (the booking row already holds the summed
  // price + extended end time). Best-effort: a failure here only loses the
  // itemized breakdown, not the booking or its total. Prices are re-derived
  // server-side inside the SECURITY DEFINER RPC.
  if (addonRows.length > 0 && bookingId) {
    try {
      await supabase.rpc("add_booking_addons", {
        p_booking_id: bookingId,
        p_service_ids: addonRows.map((a) => a.id),
      });
    } catch (e) {
      console.error("[submitPublicBooking] add_booking_addons failed", e);
    }
  }

  // staff_requested_by_client (the ❤️ chip) is stamped SERVER-SIDE in
  // runPublicBookingSideEffects below — same reason as booking_channel: a browser
  // anon UPDATE silently no-ops under RLS, so this flag never persisted online.

  // TODO Phase 2 WOW:
  // - Check client_profiles when guest enters phone
  // - Auto-fill name if already known
  // - Suggest preferred_staff_id (favorite tech)
  // - Show "Welcome back [name]!"
  // Identity resolve (name / visit_count / last_service_date / preferred_staff
  // + bookings.client_profile_id FK stamp) now happens INSIDE
  // create_public_booking via resolve_client_profile() — atomic + server-
  // authoritative (migration 20260614110000). The old best-effort browser
  // upsert that did all of that was removed (under RLS it could silently no-op,
  // and keeping it would double-count visit_count).
  //
  // OTP trust and marketing consent are finalized above through the
  // booking-capability RPC. Direct browser writes to client_profiles are
  // intentionally impossible under RLS.

  // Post-commit side-effects (deposit eval + AI no-show risk + card-required
  // flag, and the confirmation email) run in a SERVER ACTION. This flow executes
  // in the browser (anon Supabase client for RLS-scoped inserts), so the old
  // client→internal-route fetches sent an empty INTERNAL_API_SECRET and were
  // rejected on EVERY online booking (risk 401, email 403): no risk was ever
  // scored and no confirmation email ever sent. A server action has the server
  // env + uses after(), so it runs these directly without the HTTP/secret hop.
  void (async () => {
    try {
      const { data: depositRows } = await supabase.rpc(
        "get_booking_client_snapshot" as never,
        // Salon-scoped: only recognizes a phone that has booked at THIS salon,
        // so the snapshot can't be used as a cross-tenant phone→PII oracle.
        {
          p_salon_id: String(salon.id),
          p_phone: phoneOk.digits,
          p_booking_id: bookingId,
        } as never,
      );
      const cp = (Array.isArray(depositRows) ? depositRows[0] : null) as {
        no_show_count?: number; is_vip?: boolean; visit_count?: number;
      } | null;

      await runPublicBookingSideEffects({
        risk: {
          bookingId,
          clientName: nameTrimmed,
          serviceName: service.name as string,
          salonId: String(salon.id),
          startTimeUtc: startLocal.toISOString(),
          isNewCustomer: !cp || (cp.visit_count ?? 0) <= 1,
          visitCount: cp?.visit_count ?? 0,
          noShowCount: cp?.no_show_count ?? 0,
          isVip: cp?.is_vip ?? false,
          hasEmail: !!emailToStore,
          svcPriceCents: priceSnapshot ?? 0,
        },
        email: emailToStore
          ? {
              bookingId,
              shopSlug,
              clientName: nameTrimmed,
              clientEmail: emailToStore,
              serviceName: service.name as string,
              addonServiceName: addonRow?.name ?? null,
              staffName: resolvedStaffName,
              startTimeUtc: startLocal.toISOString(),
              totalPriceCents: taxResult.totalCents > 0 ? taxResult.totalCents : null,
              subtotalCents: totalPriceCents > 0 ? totalPriceCents : null,
              taxBreakdown: taxResult.breakdown.length > 0 ? taxResult.breakdown : undefined,
            }
          : undefined,
        ownerNotify: {
          salonId: String(salon.id),
          bookingId,
          event: "new",
        },
        stamp: {
          bookingId,
          bookingChannel: "online",
          clientLocale: params.language || undefined,
          staffRequested: customerRequestedStaff,
          verificationMethod:
            resolvedOtpSessionId
              ? "otp"
              : params.verificationMethod === "otp"
                ? undefined
                : params.verificationMethod || undefined,
          otpSessionId: resolvedOtpSessionId || undefined,
          healthAck: params.healthAck === true,
          subtotalCents: totalPriceCents > 0 ? totalPriceCents : undefined,
          taxAmountCents: taxResult.taxAmountCents > 0 ? taxResult.taxAmountCents : undefined,
        },
        referral: params.referralCode
          ? {
              salonId: String(salon.id),
              code: params.referralCode,
              refereePhone: phoneOk.digits,
              refereeBookingId: bookingId,
            }
          : undefined,
      });
    } catch (e) {
      console.error("[submitPublicBooking] side-effects dispatch failed", e);
    }
  })();

  // Fire-and-forget: apply promotion price discount
  if (params.promoRedemption?.promoId && bookingId && params.promoRedemption.discountCents > 0) {
    void (async () => {
      try {
        const { applyPromoToBooking } = await import("@/shared/promotions/applyPromoToBooking");
        await applyPromoToBooking(
          bookingId,
          String(salon.id),
          params.serviceId,
          params.promoRedemption!.promoId,
          params.promoRedemption!.discountCents,
        );
      } catch (e) {
        console.error("[submitPublicBooking] promo apply failed", e);
      }
    })();
  }

  // Fire-and-forget: $2 email capture discount
  if (params.emailCaptureDiscount && params.clientEmail && bookingId) {
    void (async () => {
      try {
        const { applyEmailCaptureDiscount } = await import("@/shared/promotions/applyEmailCaptureDiscount");
        await applyEmailCaptureDiscount(bookingId, String(salon.id), params.clientPhone);
      } catch (e) {
        console.error("[submitPublicBooking] email capture discount failed", e);
      }
    })();
  }

  // Fire-and-forget: redeem voucher
  if (params.voucherRedemption?.voucher_id && bookingId) {
    void (async () => {
      try {
        const appUrl = typeof window !== "undefined" ? "" : ((process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca");
        await fetch(`${appUrl}/api/vouchers/redeem`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            voucher_id: params.voucherRedemption!.voucher_id,
            salon_id: String(salon.id),
            client_phone: phoneOk.digits,
            booking_id: bookingId,
            original_price_cents: totalPriceCents + (params.voucherRedemption!.discount_cents ?? 0),
            discount_cents: params.voucherRedemption!.discount_cents,
          }),
        });
      } catch (e) {
        console.error("[submitPublicBooking] voucher redeem dispatch failed", e);
      }
    })();
  }

  // Awaited SMS confirmation — tracks sent_at / failed_at on the booking row
  try {
    const appUrl = typeof window !== "undefined" ? "" : ((process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca");
    await fetch(`${appUrl}/api/booking/sms-confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookingId,
        salonId: String(salon.id),
        clientPhone: phoneOk.digits,
        clientName: nameTrimmed,
        serviceName: service.name as string,
        staffName: resolvedStaffName,
        startTimeUtc: startLocal.toISOString(),
        language: params.language ?? null,
        // Only what the customer actually ticked. Never hardcode true: this same
        // module is reachable from server-side callers with no checkbox.
        smsConsent: params.smsConsent === true,
      }),
    });
  } catch (e) {
    console.error("[submitPublicBooking] sms-confirm dispatch failed", e);
  }

  // Wix write-back: create booking on Wix calendar (best-effort, fire-and-forget)
  void fetch("/api/booking/wix-create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId, salonId: String(salon.id) }),
  }).catch(() => {/* best-effort */});

  // verification_method + verification_completed_at + otp_session_id are stamped
  // SERVER-SIDE in runPublicBookingSideEffects above (a browser anon UPDATE here
  // silently no-op'd under RLS, so it never persisted — front desk saw online
  // OTP-verified bookings as "unverified").

  // Fire-and-forget: tag booking with combo ID for analytics.
  // `.then()` is what makes a PostgrestBuilder issue its request — a bare
  // `void supabase.from(...)` builds the query and drops it (service_combo_id
  // was never written). This runs in the browser, so it stays non-blocking.
  if (comboOverride?.comboId && bookingId) {
    void supabase
      .from("bookings")
      .update({ service_combo_id: comboOverride.comboId } as never)
      .eq("id", bookingId)
      .then(({ error }) => {
        if (error) console.error("[submitPublicBooking] service_combo_id write failed", error);
      });
  }

  // Fire-and-forget: store reference image path on booking
  if (params.referenceImagePath && bookingId) {
    void (async () => {
      try {
        const appUrl = typeof window !== "undefined" ? "" : ((process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca");
        await fetch(`${appUrl}/api/booking/set-ref-image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingId, refPath: params.referenceImagePath }),
        });
      } catch (e) {
        console.error("[submitPublicBooking] set-ref-image dispatch failed", e);
      }
    })();
  }

  return {
    bookingId,
    serviceName: service.name as string,
    startTimeUtc: startLocal.toISOString(),
    endTimeUtc: endLocal.toISOString(),
    status: "confirmed",
    price_cents: totalPriceCents,
    staffName: resolvedStaffName,
    addonServiceName: addonRow?.name ?? null,
    addonPriceCents: addonPriceSnapshot,
    addons: addonRows.map((a) => ({
      serviceId: a.id,
      name: a.name,
      priceCents: a.price_cents,
    })),
  };
}
