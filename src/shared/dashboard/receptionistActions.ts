"use server";

import { after } from "next/server";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  ConflictCheckBooking,
  checkBookingConflict,
} from "@/shared/lib/conflictCheck";
import { assertBookingLimitAvailable } from "@/shared/booking/assertBookingLimit";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import {
  canCancelBooking,
  canMarkNoShow,
  canCreateDeskBooking,
  canEditBooking,
  canUndoCancel,
} from "@/shared/lib/salonMemberRole";
import { loadBookingServicesForSalonSlug } from "@/shared/booking/loadBookingServices";
import { salonWallTimeToUtcIso } from "@/shared/lib/salonTime";
import { parseTimeSlotToMinutes } from "@/shared/booking/parseBookingTimeSlot";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { type ActorRole, logBookingEvent } from "@/shared/dashboard/auditLog";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { createDepositForBooking, refundDeposit } from "@/shared/integrations/square/deposits";
import { pushWixCancel, pushWixConfirm, pushWixDecline, pushWixCreate } from "@/shared/integrations/wix/writeback";
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

  // Wix write-back: push new walk-in to Wix calendar. after() runs it post-response so the
  // serverless function stays alive until the Wix call finishes (a bare `void` can be frozen
  // before the request completes), while never blocking the desk.
  after(() => pushWixCreate(ctx.salon.id, bid));

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
  input: { salonId: string; bookingId: string; refundDeposit?: boolean },
): Promise<{ ok: true; depositRefunded?: boolean; depositRefundError?: string } | { ok: false; error: string }> {
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

  // Write-back: if this booking came from Wix, cancel it there too. after() guarantees the
  // Wix call runs to completion after the response (a bare `void` can be cut off by the
  // serverless freeze) without blocking the desk.
  after(() => pushWixCancel(ctx.salon.id, bookingId));

  // Mutually-agreed cancel → refund the Square deposit (if any). Keep otherwise
  // (forfeit). Refund failure doesn't undo the cancel — surfaced so the desk can
  // refund manually in Square.
  if (input.refundDeposit) {
    const r = await refundDeposit(bookingId);
    return { ok: true, depositRefunded: r.ok, depositRefundError: r.ok ? undefined : r.reason };
  }

  return { ok: true };
}

/**
 * Desk: create (or return existing) a Square deposit payment link for a booking.
 * Risk-gated + amount policy live in createDepositForBooking; here we only enforce
 * auth + that the booking belongs to the caller's salon. The receptionist shows
 * the returned URL/QR to the customer on screen.
 */
export async function requestDepositLink(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true; url: string; amountCents: number } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim()) return fail("salon_mismatch");

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  // Scope check: the booking must be visible in the caller's salon (RLS client).
  const { data: bk } = await ctx.supabase
    .from("bookings")
    .select("id")
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (!bk?.id) return fail("invalid_booking");

  try {
    const r = await createDepositForBooking(bookingId);
    if (!r.required || !r.url) return fail(r.reason || "deposit_not_required");
    return { ok: true, url: r.url, amountCents: r.amountCents ?? 0 };
  } catch (e) {
    console.error("[requestDepositLink]", e);
    return fail("server_error");
  }
}

/**
 * Cancel an ENTIRE group/party at once: every still-active booking sharing a
 * `group_id` flips to `cancelled` in one statement. Owner/senior only (same
 * gate as the single-booking cancel). Mirrors `cancelDeskBooking` for audit +
 * Wix write-back, just fanned out across the group. Safe to call repeatedly —
 * the `status` guard makes it a no-op once everything is already cancelled.
 */
export async function cancelDeskGroup(
  slug: string,
  input: { salonId: string; groupId: string },
): Promise<{ ok: true; cancelledCount: number } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  if (!canCancelBooking(ctx.role)) {
    return fail("unauthorized");
  }

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const groupId = String(input.groupId ?? "").trim();
  if (!groupId || !isUuidLike(groupId)) return fail("invalid_group");

  const supabase = ctx.supabase;

  // Atomic bulk cancel scoped to salon + group + still-active rows. Returns the
  // ids actually flipped so audit + Wix write-back only fire for real changes.
  const { data: cancelled, error: upErr } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("salon_id", ctx.salon.id)
    .eq("group_id", groupId)
    .in("status", ["pending", "confirmed", "in_progress"])
    .select("id");

  if (upErr) {
    console.error("[cancelDeskGroup]", upErr);
    return fail("server_error");
  }

  const ids = (cancelled ?? []).map((r) => String(r.id));
  if (ids.length === 0) return fail("invalid_state");

  for (const bookingId of ids) {
    void logBookingEvent({
      bookingId,
      salonId: ctx.salon.id,
      actorUserId: null,
      actorRole: ctxActorRole(ctx),
      eventType: "booking_cancelled",
      payload: { reason: "desk_group_cancel", groupId },
    });
  }

  // Wix write-back per row — best-effort, after the response is flushed.
  after(() => Promise.all(ids.map((id) => pushWixCancel(ctx.salon.id, id))));

  return { ok: true, cancelledCount: ids.length };
}

/**
 * Approve a Wix-origin pending booking from the desk: confirm it in NailIQ AND push a
 * Confirm to Wix so the customer gets Wix's confirmation. Owner/senior only. Scoped to
 * rows that carry a `wix_booking_id` and are still 'pending', so NailIQ's native pending
 * (OTP/deposit) flow is untouched. Best-effort write-back never blocks the desk.
 */
export async function approveWixBooking(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canCancelBooking(ctx.role)) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim()) return fail("salon_mismatch");
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const { data: updated, error: upErr } = await ctx.supabase
    .from("bookings")
    .update({ status: "confirmed" })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("status", "pending")
    .not("wix_booking_id", "is", null)
    .select("id")
    .maybeSingle();
  if (upErr) {
    console.error("[approveWixBooking]", upErr);
    return fail("server_error");
  }
  if (!updated?.id) return fail("invalid_state");

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "booking_status_changed",
    payload: { from: "pending", to: "confirmed", reason: "wix_approve" },
  });
  after(() => pushWixConfirm(ctx.salon.id, bookingId));
  return { ok: true };
}

/** Decline a Wix-origin pending booking: cancel in NailIQ AND push a Decline to Wix. */
export async function declineWixBooking(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canCancelBooking(ctx.role)) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim()) return fail("salon_mismatch");
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const { data: updated, error: upErr } = await ctx.supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("status", "pending")
    .not("wix_booking_id", "is", null)
    .select("id")
    .maybeSingle();
  if (upErr) {
    console.error("[declineWixBooking]", upErr);
    return fail("server_error");
  }
  if (!updated?.id) return fail("invalid_state");

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "booking_cancelled",
    payload: { reason: "wix_decline" },
  });
  after(() => pushWixDecline(ctx.salon.id, bookingId));
  return { ok: true };
}

/**
 * Mark a confirmed / in-progress booking as a no-show (customer didn't attend). Terminal:
 * frees the slot and increments the client's lifetime no_show_count, which feeds the no-show
 * risk engine (and the Wix smart auto-approve). Owner/senior only.
 */
export async function markNoShowBooking(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canMarkNoShow(ctx.role)) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim()) return fail("salon_mismatch");
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const { data: updated, error: upErr } = await ctx.supabase
    .from("bookings")
    .update({ status: "no_show" })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .in("status", ["confirmed", "in_progress"])
    .select(
      "id, client_phone, client_name, client_email, service_id, services!bookings_service_id_fkey(name)",
    )
    .maybeSingle();
  if (upErr) {
    console.error("[markNoShowBooking]", upErr);
    return fail("server_error");
  }
  if (!updated?.id) return fail("invalid_state");

  // These two RPCs are SECURITY DEFINER + revoked from anon/authenticated, so
  // they're invoked with the service-role client AFTER the role/salon auth above
  // (never directly callable by an untrusted user).
  const svc = createServiceRoleClient();

  // Feed the no-show risk engine — best-effort, never fail the desk action on this.
  if (updated.client_phone) {
    const { error: bumpErr } = await svc.rpc("bump_client_no_show", { p_phone: updated.client_phone });
    if (bumpErr) console.error("[markNoShowBooking] bump", bumpErr);
  }

  // Slot recovery — flag the next matching waitlist entry + email them the claim
  // link. Best-effort; never fail the desk action on a notify hiccup.
  try {
    const svcId = (updated as { service_id?: string | null }).service_id;
    const { data: wl } = await svc.rpc("notify_waitlist_for_no_show", {
      p_booking_id: bookingId,
    });
    const row = Array.isArray(wl) ? wl[0] : wl;
    if (row?.entry_id && svcId) {
      const { notifyWaitlistForSlot } = await import(
        "@/shared/noshow/waitlistAutoFill"
      );
      await notifyWaitlistForSlot({
        salonId: ctx.salon.id,
        salonName: String(row.salon_name ?? ""),
        serviceId: String(svcId),
        serviceName: String(row.service_name ?? ""),
        bookingDateYmd: String(row.booking_date ?? ""),
      });
    }
  } catch (e) {
    console.error("[markNoShowBooking] waitlist", e);
  }

  // No-show fee — charge the saved Square card-on-file if this booking has one.
  // Idempotent (stable idempotency key) + best-effort; never fail the desk action.
  try {
    const { chargeNoShowFee } = await import(
      "@/shared/integrations/square/noshow"
    );
    await chargeNoShowFee(bookingId);
  } catch (e) {
    console.error("[markNoShowBooking] noshow-fee", e);
  }

  // Win-back — a friendly "we missed you, rebook" email (retention over
  // penalty). Opt-out via salons.winback_enabled. Best-effort, off the response
  // path; never fails the desk action.
  const winbackEmail = (updated as { client_email?: string | null }).client_email;
  if (winbackEmail && winbackEmail.trim()) {
    const clientName = String((updated as { client_name?: string | null }).client_name ?? "");
    const svcName = String(
      (updated as { services?: { name?: string | null } | null }).services?.name ?? "",
    );
    after(async () => {
      try {
        const { data: salonRow } = await ctx.supabase
          .from("salons")
          .select("name, slug, winback_enabled" as never)
          .eq("id", ctx.salon.id)
          .maybeSingle();
        const s = (salonRow ?? {}) as {
          name?: string | null;
          slug?: string | null;
          winback_enabled?: boolean | null;
        };
        if (s.winback_enabled === false || !s.slug) return;
        const { sendWinBackEmail } = await import(
          "@/shared/noshow/sendWinBackEmail"
        );
        await sendWinBackEmail({
          clientName,
          clientEmail: winbackEmail,
          salonName: String(s.name ?? ""),
          salonSlug: String(s.slug),
          serviceName: svcName,
        });
      } catch (e) {
        console.error("[markNoShowBooking] winback", e);
      }
    });
  }

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "booking_status_changed",
    payload: { to: "no_show", reason: "desk_no_show" },
  });
  return { ok: true };
}

/**
 * Undo a no-show — the customer was just running late after all. Reverts
 * `no_show` → `confirmed` and decrements the client's no_show_count (so a
 * wrongly-flagged guest, incl. an auto-marked one, isn't penalised). Same
 * front-desk roles as marking.
 */
export async function undoNoShowBooking(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canMarkNoShow(ctx.role)) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim()) return fail("salon_mismatch");
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const { data: updated, error: upErr } = await ctx.supabase
    .from("bookings")
    .update({ status: "confirmed" })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("status", "no_show")
    .select("id, client_phone")
    .maybeSingle();
  if (upErr) {
    // The slot may have been re-taken (waitlist claim / walk-in) while it was
    // freed — reverting to confirmed collides with bookings_no_overlap (23P01).
    // Surface a clear "slot taken" instead of a generic retry message.
    if ((upErr as { code?: string }).code === "23P01") {
      return fail("slot_conflict");
    }
    console.error("[undoNoShowBooking]", upErr);
    return fail("server_error");
  }
  if (!updated?.id) return fail("invalid_state");

  if (updated.client_phone) {
    // SECURITY DEFINER fn, revoked from anon/authenticated → call via service role
    // after the auth checks above.
    const svc = createServiceRoleClient();
    const { error: unbumpErr } = await svc.rpc("unbump_client_no_show", {
      p_phone: updated.client_phone,
    });
    if (unbumpErr) console.error("[undoNoShowBooking] unbump", unbumpErr);
  }

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "booking_status_changed",
    payload: { to: "confirmed", reason: "undo_no_show" },
  });
  return { ok: true };
}

/**
 * Set the ACTUAL final price on a booking — for variable-priced ('from'/'range')
 * services where the amount is only known when the work is done. Owner/senior only;
 * audit-logged. Allowed on any non-cancelled booking so the desk can record the
 * real total at checkout. Stores integer cents on bookings.price_cents.
 */
export async function setBookingFinalPrice(
  slug: string,
  input: { salonId: string; bookingId: string; priceCents: number },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canEditBooking(ctx.role)) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim()) return fail("salon_mismatch");
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const priceCents = Math.round(Number(input.priceCents));
  if (!Number.isFinite(priceCents) || priceCents < 0 || priceCents > 100_000_00) {
    return fail("invalid_price");
  }

  const { data: updated, error: upErr } = await ctx.supabase
    .from("bookings")
    .update({ price_cents: priceCents })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .not("status", "eq", "cancelled")
    .select("id")
    .maybeSingle();
  if (upErr) {
    console.error("[setBookingFinalPrice]", upErr);
    return fail("server_error");
  }
  if (!updated?.id) return fail("invalid_state");

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "booking_price_set",
    payload: { priceCents, reason: "final_price" },
  });
  return { ok: true };
}

export type {
  EditBookingError,
  EditBookingInput,
  EditBookingResult,
} from "./editBookingCore";

/**
 * Immediate undo for the 8-second cancel toast.
 * Skips the "must be in future" and conflict checks — the undo window is so
 * short (≤ 8 s) that the slot cannot realistically be taken by someone else,
 * and in_progress bookings that were cancelled already have a past start_time.
 */
export async function undoCancelBooking(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canUndoCancel(ctx.role)) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim()) return fail("salon_mismatch");

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const { data: updated, error: upErr } = await ctx.supabase
    .from("bookings")
    .update({ status: "confirmed" })
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("status", "cancelled")
    .select("id")
    .maybeSingle();

  if (upErr) {
    console.error("[undoCancelBooking]", upErr);
    return fail("server_error");
  }
  if (!updated?.id) return fail("invalid_state");

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "booking_restored",
    payload: { reason: "undo_cancel" },
  });

  return { ok: true };
}

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
    // Default false: "customer requested this staff" is an explicit opt-in
    // (form checkbox defaults off; addWalkinToQueue treats only `=== true` as a
    // request). Defaulting to true here mislabeled auto-assigned walk-ins with a
    // ❤️ request flag the guest never set (QA ReceptionistCenter ReTest2).
    staffRequestedByClient: input.staffRequestedByClient ?? false,
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
  // Immediate assign at/before "now" means the guest is being served NOW — flip
  // confirmed → in_progress so the cockpit IN SERVICE tile counts them, the
  // staff shows busy, and no false "overdue to start" nudge fires while the
  // guest sits in the chair (QA ReceptionistCenter ReTest3). Best-effort: a
  // confirmed booking is still valid if this hiccups, so we don't fail the
  // assign on it. Future-dated assigns (startAt > now) stay confirmed.
  const startMs = Date.parse(startAt);
  if (Number.isFinite(startMs) && startMs <= Date.now()) {
    await markWalkinInProgress(slug, {
      salonId: input.salonId,
      bookingId: created.bookingId,
    });
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

/**
 * Data the receptionist "New appointment" form needs: services, staff, per-staff
 * capability rows, and salon scheduling meta (opening hours, timezone, closed
 * dates, lead minutes). Auth-gated; the available-slot grid is computed
 * client-side from this, exactly like the public booking flow.
 */
export async function getDeskBookingData(slug: string): Promise<
  | { ok: true; data: NonNullable<Awaited<ReturnType<typeof loadBookingServicesForSalonSlug>>> }
  | { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canCreateDeskBooking(ctx.role)) return fail("unauthorized");
  const data = await loadBookingServicesForSalonSlug(slug);
  if (!data) return fail("not_found");
  return { ok: true, data };
}

/**
 * Create a FUTURE appointment from the front desk — the path for a phone-in
 * customer (until AI Receptionist takes calls). Reuses the same conflict-safe
 * `create_public_booking` RPC as public/voice bookings (advisory lock + the
 * `bookings_no_overlap` GIST constraint, so it can never oversell), books it as
 * `confirmed`, stamps the phone channel, and fires the same confirmation
 * SMS/email. The slot is picked client-side; the RPC is the source of truth on
 * availability, so a slot taken in the meantime returns `time_slot_taken`.
 */
export async function addDeskAppointment(
  slug: string,
  input: {
    salonId: string;
    serviceId: string;
    staffId: string;
    /** YYYY-MM-DD in salon-local time. */
    bookingDateYmd: string;
    /** Time-slot label as rendered by the grid, e.g. "9:00 AM". */
    timeSlot: string;
    clientName: string;
    clientPhone: string;
    clientEmail?: string | null;
    clientNotes?: string | null;
    language?: "en" | "vi";
  },
): Promise<OkBooking | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim()) return fail("salon_mismatch");
  if (!canCreateDeskBooking(ctx.role)) return fail("unauthorized");

  const clientName = String(input.clientName ?? "").trim();
  if (!clientName || clientName.length > BOOKING_GUEST_NAME_MAX) return fail("invalid_name");
  if (!isValidCustomerName(clientName)) return fail("invalid_name_chars");

  const phoneOk = validateGuestPhone(String(input.clientPhone ?? "").trim());
  if (!phoneOk.ok) return fail("invalid_phone");
  const canonicalPhone = toCanonicalPhone(phoneOk.digits) ?? phoneOk.digits;

  const serviceId = String(input.serviceId ?? "").trim();
  if (!isUuidLike(serviceId)) return fail("invalid_service");
  const staffId = String(input.staffId ?? "").trim();
  if (!isUuidLike(staffId)) return fail("invalid_staff");

  const dateYmd = String(input.bookingDateYmd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) return fail("invalid_date");

  const startMinutes = parseTimeSlotToMinutes(String(input.timeSlot ?? ""));
  if (!Number.isFinite(startMinutes) || startMinutes < 0) return fail("invalid_time");

  let clientEmail: string | null = null;
  const emailRaw = String(input.clientEmail ?? "").trim();
  if (emailRaw) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) return fail("invalid_email");
    clientEmail = emailRaw.toLowerCase();
  }
  const clientNotes = String(input.clientNotes ?? "").trim().slice(0, 500) || null;

  const db = createServiceRoleClient();

  // Plan-tier booking cap (same gate as walk-ins).
  try {
    const { data: planRow } = await db
      .from("salons")
      .select("subscription_plan, plan_override, feature_flags" as never)
      .eq("id", ctx.salon.id)
      .maybeSingle();
    const pf = (planRow ?? {}) as {
      subscription_plan?: string | null;
      plan_override?: string | null;
      feature_flags?: Record<string, unknown> | null;
    };
    await assertBookingLimitAvailable(db, {
      id: ctx.salon.id,
      subscription_plan: pf.subscription_plan,
      plan_override: pf.plan_override,
      feature_flags: pf.feature_flags,
    });
  } catch {
    return fail("booking_limit_reached");
  }

  // Authoritative service duration + price (don't trust the client).
  const { data: svcRow } = await db
    .from("services")
    .select("name, duration_minutes, buffer_minutes, price_cents, salon_id, deleted_at")
    .eq("id", serviceId)
    .maybeSingle();
  const svc = svcRow as {
    name?: string;
    duration_minutes?: number | null;
    buffer_minutes?: number | null;
    price_cents?: number | null;
    salon_id?: string;
    deleted_at?: string | null;
  } | null;
  if (!svc || svc.salon_id !== ctx.salon.id || svc.deleted_at) return fail("invalid_service");

  const timezone = ctx.salon.timezone;
  const startUtcIso = salonWallTimeToUtcIso(dateYmd, startMinutes, timezone);
  const totalMin = (svc.duration_minutes ?? 0) + (svc.buffer_minutes ?? 0);
  const endUtcIso = new Date(Date.parse(startUtcIso) + totalMin * 60_000).toISOString();

  // Staff name for the confirmation message.
  const { data: staffRow } = await db
    .from("staff")
    .select("name, salon_id, status")
    .eq("id", staffId)
    .maybeSingle();
  const staff = staffRow as { name?: string; salon_id?: string; status?: string } | null;
  if (!staff || staff.salon_id !== ctx.salon.id) return fail("invalid_staff");

  const { data: rpcData, error: rpcErr } = await db.rpc("create_public_booking", {
    p_salon_id: ctx.salon.id,
    p_service_id: serviceId,
    p_staff_id: staffId,
    p_client_name: clientName,
    p_client_phone: canonicalPhone,
    p_start_time_utc: startUtcIso,
    p_end_time_utc: endUtcIso,
    p_status: "confirmed",
    p_price_cents: svc.price_cents ?? null,
    p_client_notes: clientNotes,
    p_client_email: clientEmail,
  } as never);
  if (rpcErr) {
    const code = (rpcErr as { code?: string }).code;
    if (code === "P0002" || code === "23P01") return fail("time_slot_taken");
    console.error("[addDeskAppointment] rpc error", rpcErr);
    return fail("server_error");
  }
  const result = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
    | { success?: boolean; booking_id?: string; code?: string }
    | null;
  if (!result?.success || !result.booking_id) {
    return fail(result?.code === "slot_conflict" ? "time_slot_taken" : "server_error");
  }
  const bookingId = result.booking_id;

  // Track the phone-in channel (best-effort; `source` stays 'appointment').
  try {
    await db.from("bookings").update({ walkin_source: "phone" } as never).eq("id", bookingId);
  } catch {
    /* best-effort */
  }

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: null,
    actorRole: ctxActorRole(ctx),
    eventType: "booking_created",
    payload: { source: "desk_phone", staffId, serviceId },
  });

  // Same confirmation as a public booking (SMS always, email when given).
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
  const serviceName = svc.name ?? "";
  const staffName = staff.name ?? "";
  after(async () => {
    try {
      await fetch(`${base}/api/booking/sms-confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId,
          salonId: ctx.salon.id,
          clientPhone: canonicalPhone,
          clientName,
          serviceName,
          staffName,
          startTimeUtc: startUtcIso,
          language: input.language ?? null,
        }),
      });
    } catch {
      /* best-effort */
    }
    if (clientEmail) {
      const secret = (process.env.INTERNAL_API_SECRET ?? "").trim();
      try {
        await fetch(`${base}/api/booking-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-secret": secret },
          body: JSON.stringify({
            bookingId,
            shopSlug: slug,
            clientName,
            clientEmail,
            serviceName,
            staffName,
            startTimeUtc: startUtcIso,
            totalPriceCents: svc.price_cents ?? 0,
          }),
        });
      } catch {
        /* best-effort */
      }
    }
  });

  return { ok: true, bookingId };
}
