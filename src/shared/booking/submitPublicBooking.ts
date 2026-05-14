import * as Sentry from "@sentry/nextjs";
import { assertSlotWithinOpeningHours } from "@/shared/booking/assertSlotWithinOpeningHours";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { parseTimeSlotOnDate } from "@/shared/booking/parseBookingTimeSlot";
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
  /** Task #09-11 honeypot. Empty for real users (the HTML field is
   *  hidden, `tabIndex=-1`, and `aria-hidden`). Bots autofilling
   *  every input populate this — `submitPublicBooking` short-circuits
   *  with a fake-success when it's non-empty so no row is written
   *  and the bot doesn't learn it was detected. */
  clientWebsite?: string;
};

export type BookingResult = {
  bookingId: string;
  serviceName: string;
  startTimeUtc: string;
  endTimeUtc: string;
  status: "confirmed";
  price_cents: number;
  staffName: string;
  addonServiceName: string | null;
  /** Snapshot at booking time so the success/done view can show the add-on alongside its price. */
  addonPriceCents: number | null;
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
  } = params;

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
    .select("id, profile_complete, opening_hours")
    .eq("slug", shopSlug)
    .single();

  if (salonErr || !salon) throw new Error("salon_not_found");

  bookingScope.setTag("salon.id", String(salon.id));
  bookingScope.setContext("salon", {
    id: String(salon.id),
    slug: shopSlug,
  });

  if (!salon.profile_complete) throw new Error("salon_not_live");

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

  let startLocal: Date;
  try {
    startLocal = parseTimeSlotOnDate(timeSlot, bookingDateYmd);
  } catch {
    throw new Error("invalid_time_slot");
  }

  const now = new Date();
  const leadBufferMs = 15 * 60 * 1000;
  if (startLocal.getTime() < now.getTime() + leadBufferMs) {
    throw new Error("cannot_book_past");
  }

  const mainBlockMin =
    (Number(service.duration_minutes) || 0) +
    (Number(service.buffer_minutes) || 0);

  let addonBlockMin = 0;
  let addonRow: {
    id: string;
    name: string;
    price_cents: number | null;
  } | null = null;

  if (addonServiceId) {
    if (String(addonServiceId) === String(service.id)) {
      throw new Error("invalid_addon");
    }
    const { data: addSvc, error: addErr } = await supabase
      .from("services")
      .select("id, name, duration_minutes, buffer_minutes, price_cents")
      .eq("id", addonServiceId)
      .eq("salon_id", salon.id)
      .is("deleted_at" as never, null)
      .maybeSingle();

    if (addErr || !addSvc) throw new Error("addon_not_found");
    addonBlockMin =
      (Number(addSvc.duration_minutes) || 0) +
      (Number(addSvc.buffer_minutes) || 0);
    if (addonBlockMin <= 0) throw new Error("invalid_addon");
    addonRow = {
      id: String(addSvc.id),
      name: String(addSvc.name ?? ""),
      price_cents:
        addSvc.price_cents != null ? Number(addSvc.price_cents) : null,
    };
  }

  const totalBlockMin = mainBlockMin + addonBlockMin;
  const endLocal = new Date(startLocal.getTime() + totalBlockMin * 60_000);

  try {
    const anchor = new Date(
      startLocal.getFullYear(),
      startLocal.getMonth(),
      startLocal.getDate(),
      12,
      0,
      0,
      0,
    );
    assertSlotWithinOpeningHours(week, anchor, startLocal, endLocal);
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === "salon_closed_day") throw new Error("salon_closed_day");
      if (e.message === "outside_opening_hours")
        throw new Error("outside_opening_hours");
    }
    throw new Error("outside_opening_hours");
  }

  const priceSnapshot =
    service.price_cents != null ? Number(service.price_cents) : null;
  const addonPriceSnapshot =
    addonRow?.price_cents != null ? addonRow.price_cents : null;

  const { data: staffRows, error: staffListErr } = await supabase
    .from("staff")
    .select("id, name")
    .eq("salon_id", salon.id)
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
  const requiredServiceIds = addonRow
    ? [String(service.id), String(addonRow.id)]
    : [String(service.id)];
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

  const totalPriceCents =
    (priceSnapshot ?? 0) + (addonPriceSnapshot ?? 0);

  // Best-effort: stamp the staff-requested flag for the RPC path.
  // The `create_public_booking` RPC currently has a fixed parameter
  // list that doesn't include this field; rather than gate the
  // feature on a SQL function migration, we follow up with an UPDATE
  // when the customer picked a specific staff. Failures here are
  // logged but don't fail the booking — the chip just renders
  // without a heart, identical to the prior behavior.
  if (customerRequestedStaff && bookingId) {
    const { error: stampErr } = await supabase
      .from("bookings")
      .update({ staff_requested_by_client: true } as never)
      .eq("id", bookingId);
    if (stampErr) {
      const err = new Error(stampErr.message);
      err.name = "StaffRequestedFlagStampError";
      Sentry.captureException(err, {
        tags: {
          "booking.rpc": "staff_requested_flag",
          "booking.rpc.failure": "post_insert_stamp",
        },
        extra: { bookingId, message: stampErr.message },
      });
    }
  }

  // TODO Phase 2 WOW:
  // - Check client_profiles when guest enters phone
  // - Auto-fill name if already known
  // - Suggest preferred_staff_id (favorite tech)
  // - Show "Welcome back [name]!"
  try {
    const { data: existingProfile } = await supabase
      .from("client_profiles")
      .select("visit_count")
      .eq("phone", phoneOk.digits)
      .is("deleted_at" as never, null)
      .maybeSingle();

    const nextVisits = (existingProfile?.visit_count ?? 0) + 1;

    const { error: profileUpsertErr } = await supabase
      .from("client_profiles")
      .upsert(
        {
          phone: phoneOk.digits,
          name: nameTrimmed,
          preferred_staff_id: resolvedStaffId,
          last_service_date: new Date().toISOString(),
          visit_count: nextVisits,
        },
        { onConflict: "phone" },
      );

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
  };
}
