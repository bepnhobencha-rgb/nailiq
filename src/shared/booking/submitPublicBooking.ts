import * as Sentry from "@sentry/nextjs";
import { assertBookingLimitAvailable } from "@/shared/booking/assertBookingLimit";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";
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
import { createClient } from "@/shared/lib/supabase/client";
import { runPublicBookingSideEffects } from "@/shared/booking/publicBookingSideEffects";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";

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
  /** Booking-surface language. Forwarded to the confirmation SMS so it's
   *  sent in the language the customer chose (defaults to vi server-side). */
  language?: "en" | "vi";
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

  const supabase = createClient();

  const { data: salon, error: salonErr } = await supabase
    .from("salons")
    .select(
      "id, profile_complete, opening_hours, subscription_plan, plan_override, feature_flags, phone_otp_enabled, booking_lead_minutes, timezone",
    )
    .eq("slug", shopSlug)
    .single();

  if (salonErr || !salon) throw new Error("salon_not_found");

  bookingScope.setTag("salon.id", String(salon.id));
  bookingScope.setContext("salon", {
    id: String(salon.id),
    slug: shopSlug,
  });

  if (!salon.profile_complete) throw new Error("salon_not_live");

  // Validate OTP session when the salon requires phone verification.
  // Note: submitPublicBooking runs in the browser (no "use server") so we use
  // the anon `supabase` client. phone_otp_sessions has an RLS policy that allows
  // reading unconsumed/non-expired sessions by UUID (the UUID is the capability token).
  const salonPhoneOtpEnabled =
    (salon as { phone_otp_enabled?: unknown }).phone_otp_enabled === true;
  if (salonPhoneOtpEnabled) {
    const sessionId = (params.otpSessionId ?? "").trim();
    if (!sessionId) throw new Error("otp_required");

    const { data: otpSession } = await supabase
      .from("phone_otp_sessions" as never)
      .select("id, phone, consumed_at, expires_at")
      .eq("id", sessionId)
      .eq("salon_id", String(salon.id))
      .maybeSingle() as { data: { id: string; phone: string; consumed_at: string | null; expires_at: string } | null };

    if (!otpSession) throw new Error("otp_invalid");

    // Phone must match the booking phone (digits only).
    if (otpSession.phone !== phoneOk.digits) {
      throw new Error("otp_invalid");
    }

    // Mark as consumed via API — best-effort fire-and-forget so the session
    // cannot be reused (not blocking the booking flow on failure).
    void fetch("/api/booking-otp/consume-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
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
    .from("services")
    .select("id, name, duration_minutes, buffer_minutes, price_cents")
    .eq("id", serviceId)
    .eq("salon_id", salon.id)
    .is("deleted_at" as never, null)
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

  const mainBlockMin = comboOverride
    ? comboOverride.durationMinutes
    : serviceBlockMinutes(service.duration_minutes, service.buffer_minutes);

  let addonBlockMin = 0;
  type AddonRow = { id: string; name: string; price_cents: number | null };
  const addonRows: AddonRow[] = [];

  if (addonIds.length > 0) {
    if (addonIds.some((id) => id === String(service.id))) {
      throw new Error("invalid_addon");
    }
    // One round-trip for all add-ons; each must belong to the salon, be live,
    // and be flagged is_addon (prices/durations come from the DB, not client).
    const { data: addSvcs, error: addErr } = await supabase
      .from("services")
      .select("id, name, duration_minutes, buffer_minutes, price_cents, is_addon, addon_timing")
      .in("id", addonIds)
      .eq("salon_id", salon.id)
      .is("deleted_at" as never, null);

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
      const block = serviceBlockMinutes(
        addSvc.duration_minutes,
        addSvc.buffer_minutes,
      );
      if (block <= 0) throw new Error("invalid_addon");
      // Concurrent add-ons run alongside the main service → add $0 time to the
      // appointment block; only sequential ones extend the end time.
      if (addSvc.addon_timing !== "concurrent") addonBlockMin += block;
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
  const totalBlockMin = mainBlockMin + addonBlockMin;
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
    // The trailing buffer may run past close for the last booking (cleanup, no
    // next customer) — only the SERVICE must finish by close. Single-service
    // only; with add-ons keep the conservative whole-block fit. Mirrors the
    // client grid's `trailingBufferMinutes`.
    const closingTrailingBuffer =
      addonBlockMin === 0 ? Number(service.buffer_minutes) || 0 : 0;
    const serviceEndMinsOfDay = endMinsOfDay - closingTrailingBuffer;
    if (closeM <= openM) throw new Error("outside_opening_hours");
    if (
      startMinsOfDay < openM ||
      serviceEndMinsOfDay > closeM ||
      endMinsOfDay <= startMinsOfDay
    ) {
      throw new Error("outside_opening_hours");
    }
  }

  const priceSnapshot = comboOverride
    ? comboOverride.priceCents
    : service.price_cents != null
      ? Number(service.price_cents)
      : null;
  // Booking row stores the SUM of all add-on prices (null when none priced).
  const addonPriceSnapshot =
    addonRows.length > 0
      ? addonRows.reduce((sum, a) => sum + (a.price_cents ?? 0), 0)
      : null;

  const { data: staffRows, error: staffListErr } = await supabase
    .from("staff")
    .select("id, name")
    .eq("salon_id", salon.id)
    // Only ACTIVE providers are real bookable beds — must match the public
    // slot grid (loadBookingServices) + receptionist grid, both of which
    // filter status='active'. Without this, an inactive row (e.g. a
    // receptionist's auto-created staff row) is counted as an extra bed and
    // the salon gets oversold by one when auto-assigning "Any" staff.
    .eq("status", "active")
    .is("deleted_at" as never, null)
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

  // booking_channel='online' + client_locale are stamped SERVER-SIDE in
  // runPublicBookingSideEffects below. The RPC leaves booking_channel null, and
  // a browser anon `.update()` silently no-ops (UPDATE grant but no RLS UPDATE
  // policy → 0 rows, no error), which is why every online booking saved as
  // null channel. Reports use the channel; the SMS sender uses client_locale.
  if (bookingId) {
    // Notify owner/admin of the new booking (opt-in, fire-and-forget).
    void sendOwnerBookingNotification({
      salonId: String(salon.id),
      bookingId,
      event: "new",
    });
  }

  const totalPriceCents =
    (priceSnapshot ?? 0) + (addonPriceSnapshot ?? 0);

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
  try {
    // Per-phone snapshot via SECURITY DEFINER RPC — anon can no longer read
    // client_profiles directly (cross-tenant PII lockdown, migration
    // 20260609120000); the RPC returns only this one phone's row.
    const { data: snapshotRows } = await supabase.rpc(
      "get_booking_client_snapshot" as never,
      { p_phone: phoneOk.digits } as never,
    );
    const existingProfile = (Array.isArray(snapshotRows)
      ? snapshotRows[0]
      : null) as { visit_count?: number | null } | null;

    const nextVisits = (existingProfile?.visit_count ?? 0) + 1;

    const profileRow: Record<string, unknown> = {
      phone: phoneOk.digits,
      name: nameTrimmed,
      preferred_staff_id: resolvedStaffId,
      last_service_date: new Date().toISOString(),
      visit_count: nextVisits,
    };
    // "Verify once, trust": stamp the moment this phone passed OTP so future
    // bookings can skip the OTP step (see determine_booking_verification). Only
    // on an OTP-verified booking; omitted otherwise so we never clear it.
    if (params.verificationMethod === "otp") {
      profileRow.phone_verified_at = new Date().toISOString();
    }

    const { error: profileUpsertErr } = await supabase
      .from("client_profiles")
      .upsert(profileRow as never, { onConflict: "phone" });

    if (profileUpsertErr) {
      const err = new Error(profileUpsertErr.message);
      err.name = "ClientProfilesUpsertError";
      Sentry.captureException(err, {
        tags: {
          "booking.rpc": "client_profiles",
          "booking.rpc.failure": "upsert_best_effort",
        },
        extra: { message: profileUpsertErr.message },
      });
    }
  } catch {
    /* booking succeeded; profile update is best-effort */
  }

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
        { p_phone: phoneOk.digits } as never,
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
              totalPriceCents: totalPriceCents > 0 ? totalPriceCents : null,
            }
          : undefined,
        stamp: {
          bookingId,
          bookingChannel: "online",
          clientLocale: params.language || undefined,
          staffRequested: customerRequestedStaff,
        },
      });
    } catch (e) {
      console.error("[submitPublicBooking] side-effects dispatch failed", e);
    }
  })();

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
        // Consent is required by the UI before this point (QA BUG-03).
        smsConsent: true,
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

  // Record verification method on booking (smart verification audit trail)
  if (params.verificationMethod && bookingId) {
    void supabase
      .from("bookings")
      .update({
        verification_method: params.verificationMethod,
        verification_completed_at: new Date().toISOString(),
      } as never)
      .eq("id", bookingId);
  }

  // Fire-and-forget: tag booking with combo ID for analytics
  if (comboOverride?.comboId && bookingId) {
    void supabase
      .from("bookings")
      .update({ service_combo_id: comboOverride.comboId } as never)
      .eq("id", bookingId);
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
