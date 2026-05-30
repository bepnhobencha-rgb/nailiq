"use server";

import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  ConflictCheckBooking,
  checkBookingConflict,
} from "@/shared/lib/conflictCheck";
import { assertBookingLimitAvailable } from "@/shared/booking/assertBookingLimit";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import {
  canCancelBooking,
  canEditBooking,
  canUndoCancel,
} from "@/shared/lib/salonMemberRole";
import { type ActorRole, logBookingEvent } from "@/shared/dashboard/auditLog";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  type EditBookingInput,
  type EditBookingResult,
  performEditBooking,
} from "@/shared/dashboard/editBookingCore";
import {
  isQueuePriority,
  isQueueSource,
  normalizeRequestTag,
  QUEUE_REQUEST_TAGS_MAX_COUNT,
  type QueuePriority,
  type QueueSource,
} from "@/shared/types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAFF_NOTE_MAX_LEN = 200;

function isUuidLike(value: string): boolean {
  return UUID_RE.test(value.trim());
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** Map a `getDashboardWriteClient` ctx to an audit `actorRole`. The
 * demo-cookie path has no real auth user, so it gets a stable
 * `"demo_cookie"` actor instead of pretending to be the owner. */
function ctxActorRole(ctx: {
  kind: "member" | "demo_cookie";
  role: string;
}): ActorRole {
  if (ctx.kind === "demo_cookie") return "demo_cookie";
  // member ctx — role is one of the salon_members enum values, all of
  // which are valid ActorRole keys.
  return ctx.role as ActorRole;
}

type OkBooking = { ok: true; bookingId: string };

/**
 * Receptionist mutations: demo cookie (`nailiq-demo-slug` + service role) vs
 * logged-in salon member (user JWT + RLS), via `getDashboardWriteClient`.
 */
export async function addWalkinToQueue(
  slug: string,
  input: {
    salonId: string;
    clientName: string;
    clientPhone?: string | null;
    serviceId: string;
    staffRequestNote?: string | null;
    /** Explicit checkbox from the receptionist form. Walk-ins where
     * `staff_request_note` has visible content are also treated as
     * requested even if this flag is false (caller doesn't have to
     * coordinate the two). */
    staffRequestedByClient?: boolean | null;
    walkinSource?: QueueSource | null;
    walkinPriority?: QueuePriority | null;
    walkinRequestTags?: string[] | null;
    partySize?: number | null;
  },
): Promise<OkBooking | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const clientName = String(input.clientName ?? "").trim();
  if (!clientName) return fail("invalid_name");
  if (clientName.length > BOOKING_GUEST_NAME_MAX) return fail("invalid_name");
  if (!isValidCustomerName(clientName)) return fail("invalid_name_chars");

  const serviceId = String(input.serviceId ?? "").trim();
  if (!serviceId || !isUuidLike(serviceId)) return fail("invalid_service");

  const phoneRaw = String(input.clientPhone ?? "").trim();
  if (!phoneRaw) return fail("invalid_phone");

  const phoneOk = validateGuestPhone(phoneRaw);
  if (!phoneOk.ok) return fail("invalid_phone");

  const clientPhoneClean: string | null = phoneOk.digits;

  let note: string | null = null;
  if (
    input.staffRequestNote !== undefined &&
    input.staffRequestNote !== null &&
    String(input.staffRequestNote).trim() !== ""
  ) {
    const t = String(input.staffRequestNote).trim();
    if (t.length > STAFF_NOTE_MAX_LEN) return fail("note_too_long");
    note = t;
  }

  const supabase = ctx.supabase;

  // Plan-tier cap. ctx.salon doesn't carry plan fields, so we fetch
  // them here. Cheap: maybeSingle on PK; throws are caught and
  // surfaced as a recoverable error code.
  try {
    const { data: planRow } = await supabase
      .from("salons")
      .select("subscription_plan, plan_override, feature_flags" as never)
      .eq("id", ctx.salon.id)
      .maybeSingle();
    const planFields = (planRow ?? {}) as {
      subscription_plan?: string | null;
      plan_override?: string | null;
      feature_flags?: Record<string, unknown> | null;
    };
    await assertBookingLimitAvailable(supabase, {
      id: ctx.salon.id,
      subscription_plan: planFields.subscription_plan,
      plan_override: planFields.plan_override,
      feature_flags: planFields.feature_flags,
    });
  } catch (e) {
    if (
      e instanceof Error &&
      e.message === "monthly_booking_limit_reached"
    ) {
      return fail("monthly_booking_limit_reached");
    }
    throw e;
  }

  const { data: svc, error: svcErr } = await supabase
    .from("services")
    .select("id, price_cents")
    .eq("id", serviceId)
    .eq("salon_id", ctx.salon.id)
    .is("deleted_at" as never, null)
    .maybeSingle();

  if (svcErr) {
    console.error("[addWalkinToQueue] service", svcErr);
    return fail("server_error");
  }
  if (!svc?.id) return fail("service_not_found");

  const joinedAt = new Date().toISOString();
  const price =
    svc.price_cents != null ? Math.round(Number(svc.price_cents)) : null;

  const walkinSource: QueueSource | null = isQueueSource(input.walkinSource)
    ? input.walkinSource
    : null;
  const walkinPriority: QueuePriority | null = isQueuePriority(
    input.walkinPriority,
  )
    ? input.walkinPriority
    : null;

  const tagsIn = Array.isArray(input.walkinRequestTags)
    ? input.walkinRequestTags
    : [];
  const walkinRequestTags: string[] = [];
  for (const raw of tagsIn) {
    const t = normalizeRequestTag(raw);
    if (t !== null) walkinRequestTags.push(t);
    if (walkinRequestTags.length >= QUEUE_REQUEST_TAGS_MAX_COUNT) break;
  }

  const partyRaw =
    typeof input.partySize === "number" ? Math.round(input.partySize) : null;
  const partySize: number | null =
    partyRaw !== null &&
    Number.isFinite(partyRaw) &&
    partyRaw >= 1 &&
    partyRaw <= 50
      ? partyRaw
      : null;

  // Effective staff-requested signal: explicit checkbox OR a
  // non-empty note both count. Walk-ins predating the explicit
  // checkbox kept the same behavior — the note alone implies a
  // request — so this OR keeps that contract intact.
  const staffRequestedByClient =
    input.staffRequestedByClient === true || note !== null;

  // `walkin_*` / `party_size` / `staff_requested_by_client` columns
  // are not yet in the auto-generated Supabase types; cast the patch
  // object so .insert() accepts the new columns. Will become a plain
  // typed call after the next regeneration.
  const insertPatch = {
    salon_id: ctx.salon.id,
    service_id: serviceId,
    client_name: clientName,
    client_phone: clientPhoneClean,
    client_notes: null,
    staff_id: null,
    start_time_utc: null,
    end_time_utc: null,
    status: "waiting",
    source: "walkin",
    joined_queue_at: joinedAt,
    staff_request_note: note,
    staff_requested_by_client: staffRequestedByClient,
    price_cents: Number.isFinite(price ?? NaN) ? price : null,
    walkin_source: walkinSource,
    walkin_priority: walkinPriority,
    walkin_request_tags: walkinRequestTags,
    party_size: partySize,
  } as never;

  const { data: inserted, error: insErr } = await supabase
    .from("bookings")
    .insert(insertPatch)
    .select("id")
    .maybeSingle();

  if (insErr) {
    console.error("[addWalkinToQueue] insert", insErr);
    return fail("server_error");
  }
  const bid = inserted && "id" in inserted ? String(inserted.id) : "";
  if (!bid) return fail("server_error");

  void logBookingEvent({
    bookingId: bid,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "walkin_added",
    payload: {
      serviceId,
      walkinSource,
      walkinPriority,
      partySize,
    },
  });

  // Operational metric: explicit "queue_joined" alongside the
  // domain-shaped "walkin_added". The two are intentionally
  // duplicative — analytics queries the metric event independent of
  // the booking-mutation event family.
  void logBookingEvent({
    bookingId: bid,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "queue_joined",
    payload: { serviceId },
  });

  return { ok: true, bookingId: bid };
}

export async function assignWalkinToSlot(
  slug: string,
  input: {
    salonId: string;
    bookingId: string;
    staffId: string;
    slotStartUtc: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const bookingId = String(input.bookingId ?? "").trim();
  const staffId = String(input.staffId ?? "").trim();
  const slotStartUtc = String(input.slotStartUtc ?? "").trim();

  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");
  if (!staffId || !isUuidLike(staffId)) return fail("invalid_staff");
  const startMs = Date.parse(slotStartUtc);
  if (Number.isNaN(startMs)) return fail("invalid_time");

  const supabase = ctx.supabase;

  // Walk-in assign target must be active staff. Pending / inactive rows
  // exist in the dashboard but cannot receive new bookings.
  const { data: staffRow } = await supabase
    .from("staff")
    .select("id")
    .eq("id", staffId)
    .eq("salon_id", ctx.salon.id)
    .eq("status", "active")
    .is("deleted_at" as never, null)
    .maybeSingle();

  if (!staffRow?.id) return fail("staff_not_found");

  const { data: booking, error: bkErr } = await supabase
    .from("bookings")
    .select(`
      id,
      salon_id,
      status,
      source,
      service_id,
      services!bookings_service_id_fkey ( duration_minutes, buffer_minutes )
    `)
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();

  if (bkErr) {
    console.error("[assignWalkinToSlot] booking", bkErr);
    return fail("server_error");
  }
  if (
    !booking?.id ||
    String(booking.source) !== "walkin" ||
    String(booking.status) !== "waiting"
  ) {
    return fail("invalid_state");
  }

  /* Capability gate. Empty staff_services for this salon → all-capable
     fallback (skip the per-pair check). */
  const { data: hasCap } = await supabase.rpc("salon_has_staff_services", {
    p_salon_id: ctx.salon.id,
  });
  if (hasCap === true) {
    const { data: capRow } = await supabase
      .from("staff_services")
      .select("staff_id")
      .eq("staff_id", staffId)
      .eq("service_id", String(booking.service_id))
      .maybeSingle();
    if (!capRow?.staff_id) return fail("staff_cannot_perform_service");
  }

  type SvcDur = {
    duration_minutes?: unknown;
    buffer_minutes?: unknown;
  };
  const join = booking.services as SvcDur | SvcDur[] | null | undefined;
  const serviceRow = Array.isArray(join) ? join[0] : join;
  const duration = Math.round(
    Number(serviceRow?.duration_minutes ?? 0),
  );
  const buffer = Math.round(Number(serviceRow?.buffer_minutes ?? 0));
  if (!Number.isFinite(duration) || duration < 1) {
    return fail("invalid_duration");
  }
  if (!Number.isFinite(buffer) || buffer < 0) return fail("invalid_buffer");

  const totalMin = duration + buffer;
  const endMs = startMs + totalMin * 60 * 1000;
  const slotEndUtc = new Date(endMs).toISOString();

  const { data: existing, error: exErr } = await supabase
    .from("bookings")
    .select(
      "id, staff_id, start_time_utc, end_time_utc, status, client_name",
    )
    .eq("salon_id", ctx.salon.id)
    .eq("staff_id", staffId)
    .in("status", ["pending", "confirmed", "in_progress", "completed"]);

  if (exErr) {
    console.error("[assignWalkinToSlot] overlap load", exErr);
    return fail("server_error");
  }

  const conflict = checkBookingConflict({
    staffId,
    startUtcIso: slotStartUtc,
    endUtcIso: slotEndUtc,
    existingBookings: (existing ?? []) as ConflictCheckBooking[],
  });
  if (conflict !== null) {
    Sentry.captureEvent({
      message: "booking conflict detected (assign walk-in)",
      level: "warning",
      tags: {
        "nailiq.event": "booking_conflict",
        "nailiq.surface": "assign_walkin",
      },
      extra: {
        salonId: ctx.salon.id,
        bookingId,
        staffId,
        slotStartUtc,
        slotEndUtc,
        conflictBookingId: conflict.id,
      },
    });
    return fail("slot_conflict");
  }

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({
      staff_id: staffId,
      start_time_utc: slotStartUtc,
      end_time_utc: slotEndUtc,
      status: "confirmed",
    })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("source", "walkin")
    .eq("status", "waiting")
    .select("id")
    .maybeSingle();

  if (upErr) {
    // 23P01 = exclusion_violation (bookings_no_overlap GiST EXCLUDE).
    if (upErr.code === "23P01") {
      Sentry.captureEvent({
        message: "DB-level slot conflict on assign (GiST EXCLUDE)",
        level: "warning",
        tags: {
          "nailiq.event": "booking_conflict",
          "nailiq.surface": "assign_walkin",
          "nailiq.cause": "db_exclusion",
        },
        extra: { salonId: ctx.salon.id, bookingId, staffId, slotStartUtc },
      });
      return fail("slot_conflict");
    }
    console.error("[assignWalkinToSlot] update", upErr);
    Sentry.captureException(upErr, {
      tags: {
        "nailiq.event": "booking_action_error",
        "nailiq.surface": "assign_walkin",
      },
      extra: { salonId: ctx.salon.id, bookingId, where: "update" },
    });
    return fail("server_error");
  }

  if (!updated?.id) {
    return fail("lost_race");
  }

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "booking_status_changed",
    payload: {
      from: "waiting",
      to: "confirmed",
      reason: "walkin_assigned",
      staffId,
      slotStartUtc,
      slotEndUtc,
    },
  });

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "queue_assigned",
    payload: { staffId, slotStartUtc },
  });

  return { ok: true };
}

/** Remove walk-in from queue by marking cancelled (waiting only). */
export async function cancelWaitingWalkin(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const supabase = ctx.supabase;

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("source", "walkin")
    .eq("status", "waiting")
    .select("id")
    .maybeSingle();

  if (upErr) {
    console.error("[cancelWaitingWalkin]", upErr);
    return fail("server_error");
  }

  if (!updated?.id) {
    return fail("invalid_state");
  }

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "booking_cancelled",
    payload: { from: "waiting", reason: "walkin_removed" },
  });

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "queue_left",
    payload: { reason: "walkin_removed" },
  });

  return { ok: true };
}

/**
 * Undo assign: confirmed walk-in → back to queue (waiting, no slot).
 * Fails when no row matched (already in progress / still waiting / not walk-in).
 */
export async function undoWalkinAssignment(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const supabase = ctx.supabase;

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({
      status: "waiting",
      staff_id: null,
      start_time_utc: null,
      end_time_utc: null,
    })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("source", "walkin")
    .eq("status", "confirmed")
    .select("id")
    .maybeSingle();

  if (upErr) {
    console.error("[undoWalkinAssignment]", upErr);
    return fail("server_error");
  }

  if (!updated?.id) {
    return fail("already_started");
  }

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "booking_status_changed",
    payload: { from: "confirmed", to: "waiting", reason: "undo_assign" },
  });

  return { ok: true };
}

/**
 * Chair flow: confirmed walk-in with a slot → in_progress (+ started_at).
 * Receptionist drawer may instead call `updateBookingStatus` (`confirmed`/`pending` → `in_progress`); kept for callers that require `source = walkin` guard.
 */
export async function markWalkinInProgress(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const supabase = ctx.supabase;
  const startedAt = new Date().toISOString();

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({
      status: "in_progress",
      started_at: startedAt,
    })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("source", "walkin")
    .eq("status", "confirmed")
    .select("id")
    .maybeSingle();

  if (upErr) {
    console.error("[markWalkinInProgress]", upErr);
    return fail("server_error");
  }

  if (!updated?.id) {
    return fail("invalid_state");
  }

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "booking_status_changed",
    payload: { from: "confirmed", to: "in_progress", startedAt },
  });

  return { ok: true };
}

/** Grid / desk: pending | confirmed | in_progress → cancelled (atomic `status` guard). */
export async function cancelDeskBooking(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  // Defense-in-depth: UI hides the Cancel button for `nail_tech`, but a
  // direct action call (devtools / replayed request) would otherwise still
  // succeed. Owners and seniors keep full access.
  if (!canCancelBooking(ctx.role)) {
    return fail("unauthorized");
  }

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const supabase = ctx.supabase;

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .in("status", ["pending", "confirmed", "in_progress"])
    .select("id")
    .maybeSingle();

  if (upErr) {
    console.error("[cancelDeskBooking]", upErr);
    return fail("server_error");
  }

  if (!updated?.id) {
    return fail("invalid_state");
  }

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "booking_cancelled",
    payload: { reason: "desk_cancel" },
  });

  return { ok: true };
}

export type {
  EditBookingError,
  EditBookingInput,
  EditBookingResult,
} from "./editBookingCore";

/**
 * Restore a cancelled booking back to "confirmed".
 * Guards:
 *   - Only owner / senior (canUndoCancel)
 *   - Booking must be cancelled (not already active)
 *   - start_time_utc must still be in the future (≥ now + 1 min)
 *   - No active booking conflict for the same staff at that time
 */
export async function restoreCancelledBooking(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canUndoCancel(ctx.role)) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim()) return fail("salon_mismatch");

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const supabase = ctx.supabase;

  // Load the cancelled booking
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, status, staff_id, start_time_utc, end_time_utc, salon_id")
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("status", "cancelled")
    .maybeSingle();

  if (!booking) return fail("invalid_state");

  // Must be in the future
  const nowMs = Date.now();
  const startMs = new Date(booking.start_time_utc).getTime();
  if (startMs < nowMs + 60_000) return fail("booking_in_past");

  // Check no active conflict for this staff at this time
  if (booking.staff_id) {
    const { data: conflicts } = await supabase
      .from("bookings")
      .select("id")
      .eq("staff_id", booking.staff_id)
      .not("status", "in", '("cancelled","waiting")')
      .lt("start_time_utc", booking.end_time_utc)
      .gt("end_time_utc", booking.start_time_utc)
      .neq("id", bookingId)
      .limit(1);

    if (conflicts && conflicts.length > 0) return fail("slot_conflict");
  }

  // Restore to confirmed
  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update({ status: "confirmed" })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("status", "cancelled")
    .select("id")
    .maybeSingle();

  if (upErr) {
    console.error("[restoreCancelledBooking]", upErr);
    return fail("server_error");
  }
  if (!updated?.id) return fail("invalid_state");

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "booking_restored",
    payload: { reason: "desk_restore" },
  });

  return { ok: true };
}

/** Desk / grid: reschedule/adjust slots for pending | confirmed only (see `performEditBooking`). */
export async function editBooking(
  slug: string,
  input: EditBookingInput,
): Promise<EditBookingResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    return { ok: false, error: "unauthorized" };
  }
  // Defense-in-depth: UI hides the Edit button for `nail_tech`. Direct
  // action calls from a non-permitted role get rejected here.
  if (!canEditBooking(ctx.role)) {
    return { ok: false, error: "unauthorized" };
  }
  return performEditBooking(
    ctx.supabase as SupabaseClient<Database>,
    ctx.salon.id,
    input,
    { role: ctxActorRole(ctx), userId: null },
  );
}


/**
 * Composite "assign immediately" path used by the smart walk-in form
 * when the chosen staff is `isAvailableNow`. Bypasses the queue:
 * creates the booking with `addWalkinToQueue`, then transitions it
 * straight to `confirmed` via `assignWalkinToSlot` at the supplied
 * start time. Either step failing surfaces a typed error code that
 * the client maps to `mutationMessage`.
 *
 * Slot start defaults to "now" when the caller does not provide one.
 * The `addWalkinToQueue` row is left in the database even when the
 * subsequent assign fails — the receptionist can still finish the
 * assignment from the queue panel without losing the customer entry.
 */
export async function addWalkinAndAssign(
  slug: string,
  input: {
    salonId: string;
    clientName: string;
    clientPhone: string;
    serviceId: string;
    staffId: string;
    /** ISO start time. Falls back to `now()` when omitted. */
    startAtIso?: string;
    staffRequestedByClient?: boolean;
    walkinSource?: QueueSource | null;
    walkinPriority?: QueuePriority | null;
    walkinRequestTags?: string[] | null;
  },
): Promise<OkBooking | { ok: false; error: string }> {
  // Salon-level gate: when `walkin_auto_assign` is FALSE the
  // receptionist's "Assign immediately" path is disabled regardless of
  // staff availability. We still create the booking (so the form's
  // resetAfterSuccess works as before) but stop short of the assign
  // step — the customer lands in `status=waiting` and the desk
  // dispatches manually from the queue panel.
  //
  // Read the flag against the user-scoped (RLS) client; falling back
  // to TRUE on any error keeps the historical behavior intact.
  let autoAssign = true;
  {
    const ctx = await getDashboardWriteClient(slug);
    if (!ctx) return fail("unauthorized");
    if (ctx.salon.id !== String(input.salonId).trim()) {
      return fail("salon_mismatch");
    }
    const flagRes = await ctx.supabase
      .from("salons")
      .select("walkin_auto_assign" as never)
      .eq("id", ctx.salon.id)
      .maybeSingle();
    if (
      flagRes.data &&
      typeof flagRes.data === "object" &&
      "walkin_auto_assign" in flagRes.data &&
      (flagRes.data as { walkin_auto_assign: unknown }).walkin_auto_assign ===
        false
    ) {
      autoAssign = false;
    }
  }

  const created = await addWalkinToQueue(slug, {
    salonId: input.salonId,
    clientName: input.clientName,
    clientPhone: input.clientPhone,
    serviceId: input.serviceId,
    staffRequestedByClient: input.staffRequestedByClient ?? true,
    walkinSource: input.walkinSource ?? null,
    walkinPriority: input.walkinPriority ?? null,
    walkinRequestTags: input.walkinRequestTags ?? null,
  });
  if (!created.ok) return created;

  if (!autoAssign) {
    // Setting is OFF — leave the booking in `waiting`. The queue card
    // will surface it the same way any other walk-in does, and the
    // receptionist drives the assign from there.
    return created;
  }

  const startAt = input.startAtIso?.trim() || new Date().toISOString();
  const assigned = await assignWalkinToSlot(slug, {
    salonId: input.salonId,
    bookingId: created.bookingId,
    staffId: input.staffId,
    slotStartUtc: startAt,
  });
  if (!assigned.ok) {
    return { ok: false, error: assigned.error };
  }
  return created;
}


/* ───────────────────────── Soft hold (PR #104) ───────────────────────── */

const SOFT_HOLD_DEFAULT_MINUTES = 10;
const SOFT_HOLD_MAX_MINUTES = 60;

/**
 * Mark a waiting walk-in as "stepped out" — preserves their queue
 * position without requiring them to be physically present. The card
 * renders a countdown until `soft_hold_until`, after which it returns
 * to its normal waiting treatment and the receptionist is notified.
 *
 * Restricted to `status=waiting` walk-ins so a confirmed/in-progress
 * booking can not accidentally have its seat held off.
 */
export async function setSoftHold(
  slug: string,
  input: {
    salonId: string;
    bookingId: string;
    minutes?: number;
  },
): Promise<{ ok: true; holdUntilIso: string } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const requested = Number.isFinite(input.minutes) ? Math.round(input.minutes!) : SOFT_HOLD_DEFAULT_MINUTES;
  const minutes = Math.max(1, Math.min(SOFT_HOLD_MAX_MINUTES, requested));
  const holdUntilIso = new Date(Date.now() + minutes * 60_000).toISOString();

  const supabase = ctx.supabase;
  const { data: updated, error } = await supabase
    .from("bookings")
    .update({ soft_hold_until: holdUntilIso } as never)
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("source", "walkin")
    .eq("status", "waiting")
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[setSoftHold]", error);
    return fail("server_error");
  }
  if (!updated?.id) return fail("invalid_state");

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "soft_hold_set",
    payload: { minutes, holdUntilIso },
  });

  return { ok: true, holdUntilIso };
}

/**
 * Clear an active soft hold — used both by the explicit "Customer
 * came back" affordance and by the auto-expiry sweep when the hold
 * window passes. Idempotent: clearing an already-null hold is a
 * no-op success so the realtime tick can safely fire.
 */
export async function clearSoftHold(
  slug: string,
  input: { salonId: string; bookingId: string; reason?: "expired" | "returned" },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const supabase = ctx.supabase;
  const { error } = await supabase
    .from("bookings")
    .update({ soft_hold_until: null } as never)
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id);

  if (error) {
    console.error("[clearSoftHold]", error);
    return fail("server_error");
  }

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "soft_hold_expired",
    payload: { reason: input.reason ?? "returned" },
  });

  return { ok: true };
}
