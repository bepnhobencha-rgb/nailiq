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
import {
  submitGroupBooking,
  type GroupBookingMember,
  type GroupBookingResult,
} from "@/shared/booking/submitGroupBooking";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import {
  canCancelBooking,
  canMarkNoShow,
  canCreateDeskBooking,
  canCreateAfterHoursDeskBooking,
  canEditBooking,
  canUndoCancel,
  isOwnerOrAdmin,
} from "@/shared/lib/salonMemberRole";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import { loadBookingServicesForSalonSlug } from "@/shared/booking/loadBookingServices";
import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";
import {
  computeBookingTiming,
  type BookingTimingSegment,
} from "@/shared/booking/bookingTiming";
import { checkBookingWithinOpeningHours } from "@/shared/booking/bookingWithinOpeningHours";
import { evaluateControlledAfterHours } from "@/shared/booking/controlledAfterHours";
import {
  salonWallTimeToUtcIso,
  salonDayRangeUtc,
} from "@/shared/lib/salonTime";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { pickBestStaffAmongFree } from "@/shared/booking/pickBestStaffAmongFree";
import {
  buildCapabilityMap,
  filterStaffCapableForServices,
} from "@/shared/booking/staffCapability";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import { parseTimeSlotToMinutes } from "@/shared/booking/parseBookingTimeSlot";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { type ActorRole, logBookingEvent } from "@/shared/dashboard/auditLog";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import { handleBookingProtection } from "@/shared/noshow/handleBookingProtection";
import {
  createDepositForBooking,
  refundDeposit,
} from "@/shared/integrations/square/deposits";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { sendCustomerLinkEmail } from "@/shared/lib/sendCustomerLinkEmail";
import { logNotification } from "@/shared/lib/notificationLog";
import {
  getResourceMode,
  resolveFreeResource,
} from "@/shared/booking/resolveResource";
import {
  pushWixCancel,
  pushWixConfirm,
  pushWixDecline,
  pushWixCreate,
} from "@/shared/integrations/wix/writeback";
import {
  type EditBookingInput,
  type EditBookingResult,
  performEditBooking,
} from "@/shared/dashboard/editBookingCore";
import type { ReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
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

/** Acting auth user id for the audit log. `null` on the demo-cookie path
 * (no real auth user) — mirrors `ctxActorRole`'s demo handling so a desk
 * action is attributed to a specific user whenever one exists. */
function ctxActorUserId(ctx: { userId: string | null }): string | null {
  return ctx.userId;
}

type OkBooking = { ok: true; bookingId: string };

type ArchivedBookingRecoveryKind = "cancelled_rebook" | "no_show_walkin";

type ArchivedBookingRecoveryInput = {
  sourceBookingId: string;
  kind: ArchivedBookingRecoveryKind;
  /** Client-generated UUID. Persisted as the booking idempotency key so a
   * retry can be correlated without trusting names, phones, or timestamps. */
  requestId: string;
};

type ValidatedArchivedBookingRecovery = ArchivedBookingRecoveryInput & {
  recoveredByUserId: string;
};

type ExistingArchivedBookingRecovery = {
  id: string;
  idempotencyKey: string | null;
  kind: ArchivedBookingRecoveryKind | null;
  recoveredByUserId: string | null;
};

async function loadExistingArchivedBookingRecovery(
  salonId: string,
  sourceBookingId: string,
): Promise<
  { ok: true; existing: ExistingArchivedBookingRecovery | null } | { ok: false }
> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("bookings")
    .select("id, idempotency_key, recovery_kind, recovered_by_user_id" as never)
    .eq("salon_id", salonId)
    .eq("recovered_from_booking_id" as never, sourceBookingId)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[loadExistingArchivedBookingRecovery]", error);
    return { ok: false };
  }
  if (!data) return { ok: true, existing: null };
  const row = data as unknown as Record<string, unknown>;
  const rawKind = String(row.recovery_kind ?? "");
  return {
    ok: true,
    existing: {
      id: String(row.id),
      idempotencyKey:
        typeof row.idempotency_key === "string" ? row.idempotency_key : null,
      kind:
        rawKind === "cancelled_rebook" || rawKind === "no_show_walkin"
          ? rawKind
          : null,
      recoveredByUserId:
        typeof row.recovered_by_user_id === "string"
          ? row.recovered_by_user_id
          : null,
    },
  };
}

function isSameArchivedBookingRecovery(
  existing: ExistingArchivedBookingRecovery,
  recovery: ValidatedArchivedBookingRecovery,
): boolean {
  return (
    existing.idempotencyKey === recovery.requestId &&
    existing.kind === recovery.kind &&
    existing.recoveredByUserId === recovery.recoveredByUserId
  );
}

async function terminalBookingMustRemainImmutable(
  salonId: string,
  bookingId: string,
): Promise<{ ok: true; immutable: boolean } | { ok: false }> {
  if (await archivedBookingRecoveryEnabled(salonId)) {
    return { ok: true, immutable: true };
  }
  const existing = await loadExistingArchivedBookingRecovery(
    salonId,
    bookingId,
  );
  if (!existing.ok) return { ok: false };
  // Feature rollback may restore the legacy behavior only for untouched
  // terminal rows. Once a linked child exists, reopening the source would
  // create two active records and is therefore permanently forbidden.
  return { ok: true, immutable: existing.existing !== null };
}

async function archivedBookingRecoveryEnabled(
  salonId: string,
): Promise<boolean> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("salons")
    .select("feature_flags" as never)
    .eq("id", salonId)
    .maybeSingle();
  return isReleaseFeatureVisible(
    {
      feature_flags: (data as { feature_flags?: unknown } | null)
        ?.feature_flags,
    },
    "archived_booking_recovery",
  );
}

async function validateArchivedBookingRecovery(
  ctx: Awaited<ReturnType<typeof getDashboardWriteClient>>,
  input: ArchivedBookingRecoveryInput | undefined,
  expectedKind: ArchivedBookingRecoveryKind,
): Promise<
  | {
      ok: true;
      recovery: ValidatedArchivedBookingRecovery | null;
      existingBookingId: string | null;
    }
  | { ok: false; error: string }
> {
  if (!input) {
    return { ok: true, recovery: null, existingBookingId: null };
  }
  if (
    !ctx ||
    ctx.kind !== "member" ||
    !ctx.userId ||
    !isOwnerOrAdmin(ctx.role)
  ) {
    return fail("unauthorized");
  }

  const sourceBookingId = String(input.sourceBookingId ?? "").trim();
  const requestId = String(input.requestId ?? "").trim();
  if (!isUuidLike(sourceBookingId) || !isUuidLike(requestId)) {
    return fail("invalid_recovery");
  }
  if (input.kind !== expectedKind) return fail("invalid_recovery");

  const db = createServiceRoleClient();
  const expectedStatus =
    expectedKind === "cancelled_rebook" ? "cancelled" : "no_show";
  const { data: source, error: sourceError } = await db
    .from("bookings")
    .select("id, status")
    .eq("id", sourceBookingId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (sourceError) {
    console.error("[validateArchivedBookingRecovery] source", sourceError);
    return fail("server_error");
  }
  if (!source?.id || String(source.status) !== expectedStatus) {
    return fail("invalid_recovery_source");
  }

  const existingResult = await loadExistingArchivedBookingRecovery(
    ctx.salon.id,
    sourceBookingId,
  );
  if (!existingResult.ok) {
    return fail("server_error");
  }

  const recovery: ValidatedArchivedBookingRecovery = {
    sourceBookingId,
    kind: expectedKind,
    requestId,
    recoveredByUserId: ctx.userId,
  };
  if (existingResult.existing) {
    return isSameArchivedBookingRecovery(existingResult.existing, recovery)
      ? {
          ok: true,
          recovery,
          existingBookingId: existingResult.existing.id,
        }
      : fail("already_recovered");
  }

  // A completed request is acknowledged above even if an operator has since
  // disabled the pilot or connected Wix. That read-only replay is the core
  // idempotency guarantee. These gates apply only before creating a new child.
  if (!(await archivedBookingRecoveryEnabled(ctx.salon.id))) {
    return fail("feature_not_enabled");
  }

  const { data: wixIntegration, error: wixError } = await db
    .from("wix_integrations")
    .select("salon_id")
    .eq("salon_id", ctx.salon.id)
    .eq("enabled", true)
    .maybeSingle();
  if (wixError) {
    console.error("[validateArchivedBookingRecovery] wix", wixError);
    return fail("server_error");
  }
  if (wixIntegration?.salon_id) {
    return fail("external_calendar_not_supported");
  }

  return {
    ok: true,
    recovery,
    existingBookingId: null,
  };
}

/** Desk appointment row, shaped exactly like one `ReceptionistCenterData.bookingsForDay`
 * item so the client can drop it straight into the grid optimistically. */
type DeskBookingRow = ReceptionistCenterData["bookingsForDay"][number];
type OkDeskBooking = {
  ok: true;
  bookingId: string;
  /** Omitted on an idempotent replay; the client reloads canonical day data. */
  booking?: DeskBookingRow;
};

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
    /** Terminal booking recovery. The source remains immutable; this insert
     * creates the new walk-in and links it for audit/idempotency. */
    recovery?: ArchivedBookingRecoveryInput;
  },
): Promise<OkBooking | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");

  if (ctx.salon.id !== String(input.salonId).trim()) {
    return fail("salon_mismatch");
  }

  const recoveryResult = await validateArchivedBookingRecovery(
    ctx,
    input.recovery,
    "no_show_walkin",
  );
  if (!recoveryResult.ok) return recoveryResult;
  const recovery = recoveryResult.recovery;
  if (recoveryResult.existingBookingId) {
    return { ok: true, bookingId: recoveryResult.existingBookingId };
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
    if (e instanceof Error && e.message === "monthly_booking_limit_reached") {
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
    booking_channel: "walkin",
    joined_queue_at: joinedAt,
    staff_request_note: note,
    staff_requested_by_client: staffRequestedByClient,
    price_cents: Number.isFinite(price ?? NaN) ? price : null,
    walkin_source: walkinSource,
    walkin_priority: walkinPriority,
    walkin_request_tags: walkinRequestTags,
    party_size: partySize,
    ...(recovery
      ? {
          recovered_from_booking_id: recovery.sourceBookingId,
          recovery_kind: recovery.kind,
          recovered_by_user_id: recovery.recoveredByUserId,
          idempotency_key: recovery.requestId,
        }
      : {}),
  } as never;

  const { data: inserted, error: insErr } = await supabase
    .from("bookings")
    .insert(insertPatch)
    .select("id")
    .maybeSingle();

  if (insErr) {
    if ((insErr as { code?: string }).code === "23505" && recovery) {
      const raced = await loadExistingArchivedBookingRecovery(
        ctx.salon.id,
        recovery.sourceBookingId,
      );
      if (
        raced.ok &&
        raced.existing &&
        isSameArchivedBookingRecovery(raced.existing, recovery)
      ) {
        return { ok: true, bookingId: raced.existing.id };
      }
      return fail("already_recovered");
    }
    console.error("[addWalkinToQueue] insert", insErr);
    return fail("server_error");
  }
  const bid = inserted && "id" in inserted ? String(inserted.id) : "";
  if (!bid) return fail("server_error");

  // Owner/admin "new booking" alert (opt-in, fire-and-forget).
  if (!recovery) {
    after(() =>
      sendOwnerBookingNotification({
        salonId: ctx.salon.id,
        bookingId: bid,
        event: "new",
      }),
    );
  }

  void logBookingEvent({
    bookingId: bid,
    salonId: ctx.salon.id,
    actorUserId: ctxActorUserId(ctx),
    actorRole: ctxActorRole(ctx),
    eventType: "walkin_added",
    payload: {
      serviceId,
      walkinSource,
      walkinPriority,
      partySize,
      ...(recovery
        ? {
            recoveredFromBookingId: recovery.sourceBookingId,
            recoveryKind: recovery.kind,
          }
        : {}),
    },
  });

  if (recovery) {
    void logBookingEvent({
      bookingId: bid,
      salonId: ctx.salon.id,
      actorUserId: ctxActorUserId(ctx),
      actorRole: ctxActorRole(ctx),
      eventType: "booking_recovered",
      payload: {
        sourceBookingId: recovery.sourceBookingId,
        recoveryKind: recovery.kind,
      },
    });
  }

  // Operational metric: explicit "queue_joined" alongside the
  // domain-shaped "walkin_added". The two are intentionally
  // duplicative — analytics queries the metric event independent of
  // the booking-mutation event family.
  void logBookingEvent({
    bookingId: bid,
    salonId: ctx.salon.id,
    actorUserId: ctxActorUserId(ctx),
    actorRole: ctxActorRole(ctx),
    eventType: "queue_joined",
    payload: { serviceId },
  });

  // Wix write-back: push new walk-in to Wix calendar. after() runs it post-response so the
  // serverless function stays alive until the Wix call finishes (a bare `void` can be frozen
  // before the request completes), while never blocking the desk.
  if (!recovery) after(() => pushWixCreate(ctx.salon.id, bid));

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
    .select(
      `
      id,
      salon_id,
      status,
      source,
      service_id,
      services!bookings_service_id_fkey ( duration_minutes, buffer_minutes )
    `,
    )
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
  const duration = Math.round(Number(serviceRow?.duration_minutes ?? 0));
  const buffer = Math.round(Number(serviceRow?.buffer_minutes ?? 0));
  if (!Number.isFinite(duration) || duration < 1) {
    return fail("invalid_duration");
  }
  if (!Number.isFinite(buffer) || buffer < 0) return fail("invalid_buffer");

  const totalMin = serviceBlockMinutes(duration, buffer);
  const endMs = startMs + totalMin * 60 * 1000;
  const slotEndUtc = new Date(endMs).toISOString();

  const { data: existing, error: exErr } = await supabase
    .from("bookings")
    .select("id, staff_id, start_time_utc, end_time_utc, status, client_name")
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

  // Resource-mode salons: auto-assign a free resource (bed/chair) on seat-down.
  const walkinUpdate: Record<string, unknown> = {
    staff_id: staffId,
    start_time_utc: slotStartUtc,
    end_time_utc: slotEndUtc,
    status: "confirmed",
  };
  const walkinResMode = await getResourceMode(supabase, ctx.salon.id);
  if (walkinResMode.enabled) {
    const rr = await resolveFreeResource(
      supabase,
      ctx.salon.id,
      slotStartUtc,
      slotEndUtc,
    );
    if (!rr.resourceId) return fail("no_resource_available");
    walkinUpdate.resource_id = rr.resourceId;
  }

  const { data: updated, error: upErr } = await supabase
    .from("bookings")
    .update(walkinUpdate as never)
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
    actorUserId: ctxActorUserId(ctx),
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
    actorUserId: ctxActorUserId(ctx),
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
    actorUserId: ctxActorUserId(ctx),
    actorRole: ctxActorRole(ctx),
    eventType: "booking_cancelled",
    payload: { from: "waiting", reason: "walkin_removed" },
  });

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: ctxActorUserId(ctx),
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
    actorUserId: ctxActorUserId(ctx),
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
      no_show_candidate_at: null,
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
    actorUserId: ctxActorUserId(ctx),
    actorRole: ctxActorRole(ctx),
    eventType: "booking_status_changed",
    payload: { from: "confirmed", to: "in_progress", startedAt },
  });

  return { ok: true };
}

/** Grid / desk: pending | confirmed | in_progress → cancelled (atomic `status` guard). */
export async function cancelDeskBooking(
  slug: string,
  input: {
    salonId: string;
    bookingId: string;
    refundDeposit?: boolean;
    /** Channels to notify the customer on. When set, the cancel notification is
     *  ENQUEUED (not sent inline) with a short grace window so an Undo can cancel
     *  it before the cron delivers it. Omitted/empty → no customer notification. */
    notify?: { sms?: boolean; email?: boolean };
  },
): Promise<
  | { ok: true; depositRefunded?: boolean; depositRefundError?: string }
  | { ok: false; error: string }
> {
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
    .select("id, service_id")
    .maybeSingle();

  if (upErr) {
    console.error("[cancelDeskBooking]", upErr);
    return fail("server_error");
  }

  if (!updated?.id) {
    return fail("invalid_state");
  }

  // Owner/admin "cancelled" alert (opt-in, fire-and-forget).
  after(() =>
    sendOwnerBookingNotification({
      salonId: ctx.salon.id,
      bookingId,
      event: "cancel",
    }),
  );

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: ctxActorUserId(ctx),
    actorRole: ctxActorRole(ctx),
    eventType: "booking_cancelled",
    payload: { reason: "desk_cancel" },
  });

  // Enqueue the customer cancel notification with a 20s grace window. A durable
  // queue (not a client timer): survives the tab closing, the cron delivers it,
  // and undoCancelBooking flips it to 'cancelled' if the desk reverses within
  // the window. Service-role insert (RLS denies anon/auth on this table).
  const notifySms = input.notify?.sms === true;
  const notifyEmail = input.notify?.email === true;
  if (notifySms || notifyEmail) {
    const sr = createServiceRoleClient();
    const sendAfter = new Date(Date.now() + 20_000).toISOString();
    const { error: enqErr } = await sr.from("scheduled_notifications").insert({
      salon_id: ctx.salon.id,
      booking_id: bookingId,
      event: "cancel",
      channels: { sms: notifySms, email: notifyEmail },
      send_after: sendAfter,
    } as never);
    if (enqErr)
      console.error("[cancelDeskBooking] enqueue notify failed", enqErr);
  }

  // Write-back: if this booking came from Wix, cancel it there too. after() guarantees the
  // Wix call runs to completion after the response (a bare `void` can be cut off by the
  // serverless freeze) without blocking the desk.
  after(() => pushWixCancel(ctx.salon.id, bookingId));

  // Slot recovery — flag the next matching waitlist entry + send them the claim
  // link. Mirrors the same pattern used in markNoShowBooking. Best-effort;
  // never fail the cancel on a notify hiccup.
  try {
    const svcId = (updated as { service_id?: string | null }).service_id;
    const svc = createServiceRoleClient();
    const { data: wl } = await svc.rpc("notify_waitlist_for_no_show", {
      p_booking_id: bookingId,
    });
    const row = Array.isArray(wl) ? wl[0] : wl;
    if (row?.entry_id && svcId) {
      const { notifyWaitlistForSlot } =
        await import("@/shared/noshow/waitlistAutoFill");
      await notifyWaitlistForSlot({
        salonId: ctx.salon.id,
        salonName: String(row.salon_name ?? ctx.salon.name ?? ""),
        serviceId: String(svcId),
        serviceName: String(row.service_name ?? ""),
        bookingDateYmd: String(row.booking_date ?? "").slice(0, 10),
      });
    }
  } catch (e) {
    console.error("[cancelDeskBooking] waitlist", e);
  }

  // Mutually-agreed cancel → refund the Square deposit (if any). Keep otherwise
  // (forfeit). Refund failure doesn't undo the cancel — surfaced so the desk can
  // refund manually in Square.
  if (input.refundDeposit) {
    const r = await refundDeposit(bookingId);
    return {
      ok: true,
      depositRefunded: r.ok,
      depositRefundError: r.ok ? undefined : r.reason,
    };
  }

  return { ok: true };
}

/** Text the Square deposit pay-link to the customer (best-effort). Bilingual —
 *  the receptionist's dashboard language drives the copy. Returns false on a
 *  missing phone or a Twilio failure so the desk can fall back to the QR. */
async function sendDepositSms(args: {
  phone: string;
  salonName: string;
  amountCents: number;
  url: string;
  language: "en" | "vi";
}): Promise<boolean> {
  const phone = args.phone.trim();
  if (!phone) return false;
  const amount = `$${(args.amountCents / 100).toFixed(2)}`;
  const salon = args.salonName.trim() || "NailIQ";
  const body =
    args.language === "en"
      ? `${salon}: Please pay your ${amount} deposit to hold your appointment: ${args.url}`
      : `${salon}: Vui lòng đặt cọc ${amount} để giữ lịch hẹn của bạn: ${args.url}`;
  try {
    const res = await sendSmsReminder(phone, body, {
      lang: args.language === "en" ? "en" : "vi",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Desk: create (or return existing) a Square deposit payment link for a booking,
 * and optionally text it to the customer. Amount policy lives in
 * createDepositForBooking; here we enforce auth + salon scope. `manual` lets the
 * receptionist request a deposit regardless of no-show risk (the human decided);
 * `sendSms` texts the link via Twilio. The link is also shown as a QR on screen.
 */
export async function requestDepositLink(
  slug: string,
  input: {
    salonId: string;
    bookingId: string;
    /** Receptionist-initiated → bypass the no-show-risk gate. */
    manual?: boolean;
    /** Also text the pay link to the customer's phone. */
    sendSms?: boolean;
    /** Dashboard language for the SMS copy. */
    language?: "en" | "vi";
    /** Hold the slot only until the deposit is paid — auto-cancel a FUTURE
     *  booking if unpaid past the grace window. Default ON (pay-to-confirm). */
    hold?: boolean;
  },
): Promise<
  | {
      ok: true;
      url: string;
      amountCents: number;
      smsSent?: boolean;
      emailSent?: boolean;
    }
  | { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim())
    return fail("salon_mismatch");

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  // Scope check: the booking must be visible in the caller's salon (RLS client).
  // Pull phone + email so we can deliver the link on both channels in one pass.
  const { data: bk } = await ctx.supabase
    .from("bookings")
    .select("id, client_phone, client_email, client_name")
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (!bk?.id) return fail("invalid_booking");

  const { data: salonRow } = await ctx.supabase
    .from("salons")
    .select("email_links_enabled, address")
    .eq("id", ctx.salon.id)
    .maybeSingle();

  try {
    const r = await createDepositForBooking(bookingId, {
      manual: input.manual === true,
      hold: input.hold,
    });
    if (!r.required || !r.url) return fail(r.reason || "deposit_not_required");

    const en = input.language === "en";
    let smsSent: boolean | undefined;
    if (input.sendSms) {
      smsSent = await sendDepositSms({
        phone: String((bk as { client_phone?: string }).client_phone ?? ""),
        salonName: ctx.salon.name,
        amountCents: r.amountCents ?? 0,
        url: r.url,
        language: en ? "en" : "vi",
      });
    }

    // Parallel email channel — same link, resilient to US SMS link filtering.
    // Only when the desk chose to notify the customer (sendSms = the notify
    // intent); if they only want the on-screen QR, don't email unprompted.
    let emailSent: boolean | undefined;
    const emailEnabled =
      (salonRow as { email_links_enabled?: boolean } | null)
        ?.email_links_enabled !== false;
    const email = String(
      (bk as { client_email?: string }).client_email ?? "",
    ).trim();
    if (input.sendSms && emailEnabled && email) {
      const salonName = ctx.salon.name?.trim() || "NailIQ";
      const amount = `$${((r.amountCents ?? 0) / 100).toFixed(2)}`;
      const er = await sendCustomerLinkEmail({
        email,
        clientName: (bk as { client_name?: string }).client_name ?? null,
        salonName,
        salonAddress:
          (salonRow as { address?: string | null } | null)?.address ?? null,
        lang: en ? "en" : "vi",
        subject: en
          ? `Pay your ${amount} deposit to hold your appointment · ${salonName}`
          : `Đặt cọc ${amount} để giữ lịch hẹn · ${salonName}`,
        bodyText: en
          ? `Please pay your ${amount} deposit to confirm and hold your appointment.`
          : `Vui lòng đặt cọc ${amount} để xác nhận và giữ lịch hẹn của bạn.`,
        ctaLabel: en ? `Pay ${amount} deposit` : `Đặt cọc ${amount}`,
        url: r.url,
      });
      emailSent = er.ok;
    }

    return {
      ok: true,
      url: r.url,
      amountCents: r.amountCents ?? 0,
      smsSent,
      emailSent,
    };
  } catch (e) {
    console.error("[requestDepositLink]", e);
    return fail("server_error");
  }
}

/**
 * Desk: send the customer a Square link to pay their own no-show fee — the
 * recovery path when the saved card just won't charge. Front-desk gated; mirrors
 * requestDepositLink's SMS+email delivery. The fee flips to 'charged' when the
 * link is paid (reconcileNoShowFeeLinks in the square-sync cron).
 */
export async function sendNoShowFeeLink(
  slug: string,
  input: {
    salonId: string;
    bookingId: string;
    sendSms?: boolean;
    language?: "en" | "vi";
  },
): Promise<
  | {
      ok: true;
      url: string;
      amountCents: number;
      smsSent?: boolean;
      emailSent?: boolean;
    }
  | { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canMarkNoShow(ctx.role)) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim())
    return fail("salon_mismatch");
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const { data: bk } = await ctx.supabase
    .from("bookings")
    .select("id, client_phone, client_email, client_name")
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (!bk?.id) return fail("invalid_booking");

  const { data: salonRow } = await ctx.supabase
    .from("salons")
    .select("email_links_enabled, address")
    .eq("id", ctx.salon.id)
    .maybeSingle();

  try {
    const { createNoShowFeeLink } =
      await import("@/shared/integrations/square/noshow");
    const r = await createNoShowFeeLink(bookingId);
    if (!r.ok || !r.url) return fail(r.reason || "fee_link_failed");

    const en = input.language === "en";
    const amount = `$${((r.amountCents ?? 0) / 100).toFixed(2)}`;
    const salon = ctx.salon.name?.trim() || "NailIQ";

    let smsSent: boolean | undefined;
    if (input.sendSms) {
      const phone = String(
        (bk as { client_phone?: string }).client_phone ?? "",
      ).trim();
      if (phone) {
        const body = en
          ? `${salon}: Please pay your ${amount} no-show fee: ${r.url}`
          : `${salon}: Vui lòng thanh toán phí no-show ${amount}: ${r.url}`;
        try {
          smsSent = (
            await sendSmsReminder(phone, body, { lang: en ? "en" : "vi" })
          ).ok;
        } catch {
          smsSent = false;
        }
      }
    }

    let emailSent: boolean | undefined;
    const emailEnabled =
      (salonRow as { email_links_enabled?: boolean } | null)
        ?.email_links_enabled !== false;
    const email = String(
      (bk as { client_email?: string }).client_email ?? "",
    ).trim();
    if (input.sendSms && emailEnabled && email) {
      const er = await sendCustomerLinkEmail({
        email,
        clientName: (bk as { client_name?: string }).client_name ?? null,
        salonName: salon,
        salonAddress:
          (salonRow as { address?: string | null } | null)?.address ?? null,
        lang: en ? "en" : "vi",
        subject: en
          ? `Pay your ${amount} no-show fee · ${salon}`
          : `Thanh toán phí no-show ${amount} · ${salon}`,
        bodyText: en
          ? `Please pay the ${amount} no-show fee for your missed appointment.`
          : `Vui lòng thanh toán phí no-show ${amount} cho lịch hẹn đã lỡ.`,
        ctaLabel: en ? `Pay ${amount}` : `Thanh toán ${amount}`,
        url: r.url,
      });
      emailSent = er.ok;
    }

    void logBookingEvent({
      bookingId,
      salonId: ctx.salon.id,
      actorUserId: ctxActorUserId(ctx),
      actorRole: ctxActorRole(ctx),
      eventType: "booking_status_changed",
      payload: { reason: "desk_send_noshow_fee_link" },
    });
    return {
      ok: true,
      url: r.url,
      amountCents: r.amountCents ?? 0,
      smsSent,
      emailSent,
    };
  } catch (e) {
    console.error("[sendNoShowFeeLink]", e);
    return fail("server_error");
  }
}

/**
 * Create a GROUP booking from the front desk. Thin wrapper over the shared
 * `submitGroupBooking` (same engine the public flow uses, so the AI scheduler /
 * conflict checks / add-on handling are identical) with desk auth on top:
 * receptionist must be an authenticated salon member allowed to create bookings.
 *
 * Phone-OTP: when the salon has `phone_otp_enabled`, the public flow makes the
 * customer verify their phone. At the desk the receptionist vouches for the
 * party in person, so we mint a verified `phone_otp_sessions` row for the
 * organizer (same row shape the OTP-verify endpoint creates) and hand its id to
 * `submitGroupBooking`. This is done server-side AFTER dashboard auth, so a
 * customer can never forge it. (We deliberately do NOT call getDashboardWriteClient
 * from inside submitGroupBooking — that import forms a server-action cycle.)
 */
export async function createDeskGroup(
  slug: string,
  input: {
    salonId: string;
    members: GroupBookingMember[];
    idempotencyKey: string;
    seatTogether?: boolean;
    language?: "en" | "vi";
    /** Management-only exception for a specific-time party that crosses close. */
    afterHoursOverride?: { staffConsentConfirmed?: boolean };
  },
): Promise<
  GroupBookingResult | { ok: false; reason: "unauthorized" | "salon_mismatch" }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, reason: "unauthorized" };
  if (!canCreateDeskBooking(ctx.role))
    return { ok: false, reason: "unauthorized" };
  if (ctx.salon.id !== String(input.salonId).trim()) {
    return { ok: false, reason: "salon_mismatch" };
  }

  const wantsAfterHours = input.afterHoursOverride != null;
  if (wantsAfterHours) {
    if (
      ctx.kind !== "member" ||
      !ctx.userId ||
      !canCreateAfterHoursDeskBooking(ctx.role)
    ) {
      return { ok: false, reason: "after_hours_not_allowed" };
    }
    if (input.afterHoursOverride?.staffConsentConfirmed !== true) {
      return { ok: false, reason: "staff_consent_required" };
    }
    if (input.members.some((member) => !isUuidLike(member.staffId))) {
      return { ok: false, reason: "specific_staff_required" };
    }
  }

  let otpSessionId: string | null = null;
  const db = createServiceRoleClient();
  try {
    const { data: srow } = await db
      .from("salons")
      .select("phone_otp_enabled")
      .eq("id", ctx.salon.id)
      .maybeSingle();
    if (
      (srow as { phone_otp_enabled?: boolean } | null)?.phone_otp_enabled ===
      true
    ) {
      const v = validateGuestPhone(input.members[0]?.phone ?? "");
      if (v.ok) {
        const { data: otpRow } = await db
          .from("phone_otp_sessions")
          .insert({ phone: v.digits, salon_id: ctx.salon.id } as never)
          .select("id")
          .single();
        otpSessionId = (otpRow as { id?: string } | null)?.id ?? null;
      }
    }
  } catch {
    /* mint failed → submitGroupBooking will surface otp_required, handled by UI */
  }

  const groupParams = {
    shopSlug: slug,
    members: input.members,
    idempotencyKey: input.idempotencyKey,
    seatTogether: input.seatTogether,
    language: input.language,
    otpSessionId,
    // Front-desk-entered party — keeps the channel breakdown honest instead of
    // letting desk groups fall through to the 'online' default.
    bookingChannel: "desk" as const,
  };
  const result =
    wantsAfterHours && ctx.kind === "member" && ctx.userId
      ? await submitGroupBooking(groupParams, {
          controlledAfterHours: {
            actorUserId: ctx.userId,
            staffConsentConfirmed: true,
          },
          insertGroupBookings: async (payload) => {
            const write = await db.rpc(
              "insert_controlled_after_hours_group_bookings" as never,
              {
                p_bookings: payload,
                p_actor_user_id: ctx.userId,
              } as never,
            );
            return {
              data: write.data,
              error: write.error
                ? { code: write.error.code, message: write.error.message }
                : null,
            };
          },
        })
      : await submitGroupBooking(groupParams);

  // Unified no-show protection gate (desk group): only the lead carries a phone,
  // so protect the lead booking. Server-side here (submitGroupBooking is also
  // called from the browser, so the server-only gate can't live inside it).
  const leadId =
    result.ok && Array.isArray(result.bookingIds) ? result.bookingIds[0] : null;
  if (leadId) await handleBookingProtection(leadId, ctx.salon.id, "group");

  if (result.ok && Array.isArray(result.bookingIds)) {
    result.bookingIds.forEach(
      (id) =>
        void logBookingEvent({
          bookingId: id,
          salonId: ctx.salon.id,
          actorUserId: ctxActorUserId(ctx),
          actorRole: ctxActorRole(ctx),
          eventType: wantsAfterHours
            ? "booking_after_hours_created"
            : "booking_created",
          payload: {
            source: "desk_group",
            memberCount: result.bookingIds!.length,
            ...(wantsAfterHours
              ? {
                  staffConsentConfirmed: true,
                  approvedBy: ctx.userId,
                  staffIds: Array.from(
                    new Set(input.members.map((member) => member.staffId)),
                  ),
                }
              : {}),
          },
        }),
    );

    // Confirmation email to organizer (only they carry an email address).
    const organizer = input.members[0];
    const organizerEmail = organizer?.email?.trim() || null;
    if (leadId && organizerEmail) {
      void (async () => {
        try {
          const { data: leadRow } = await db
            .from("bookings")
            .select(
              "start_time_utc, price_cents, services!bookings_service_id_fkey(name), staff!bookings_staff_id_fkey(name)",
            )
            .eq("id", leadId)
            .maybeSingle();
          if (!leadRow) return;
          const base =
            (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() ||
            "https://nailiq.ca";
          await fetch(`${base}/api/booking-email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-secret": (
                process.env.INTERNAL_API_SECRET ?? ""
              ).trim(),
            },
            body: JSON.stringify({
              bookingId: leadId,
              shopSlug: slug,
              clientName: organizer.name,
              clientEmail: organizerEmail,
              serviceName:
                (leadRow.services as { name?: string } | null)?.name ?? "",
              staffName:
                (leadRow.staff as { name?: string } | null)?.name ?? "",
              startTimeUtc: leadRow.start_time_utc,
              totalPriceCents: leadRow.price_cents ?? null,
            }),
          });
        } catch {
          /* best-effort — email failure must not affect the booking */
        }
      })();
    }
  }

  return result;
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
  input: {
    salonId: string;
    groupId: string;
    /** Channels to notify the organizer on. Only the organizer row (member 0)
     *  carries contact info, so we enqueue ONE cancel notification for it —
     *  mirrors cancelDeskBooking. Omitted/empty → no customer notification. */
    notify?: { sms?: boolean; email?: boolean };
  },
): Promise<
  { ok: true; cancelledCount: number } | { ok: false; error: string }
> {
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
      actorUserId: ctxActorUserId(ctx),
      actorRole: ctxActorRole(ctx),
      eventType: "booking_cancelled",
      payload: { reason: "desk_group_cancel", groupId },
    });
  }

  // Owner/manager alert — group cancellation (best-effort, fire-and-forget,
  // independent of the customer notify flags below). One email for the whole
  // party, using the lead booking id.
  after(() =>
    sendOwnerBookingNotification({
      salonId: ctx.salon.id,
      bookingId: ids[0],
      event: "cancel",
      groupSize: ids.length,
    }),
  );

  // Notify the organizer (best-effort). Only member 0 carries a phone/email, so
  // enqueue ONE cancel notification for that lead row — same durable-queue +
  // 20s grace pattern as cancelDeskBooking. The cron only sends on channels the
  // booking actually has contact for.
  const notifySms = input.notify?.sms === true;
  const notifyEmail = input.notify?.email === true;
  if (notifySms || notifyEmail) {
    try {
      const sr = createServiceRoleClient();
      const { data: lead } = await sr
        .from("bookings")
        .select("id")
        .eq("salon_id", ctx.salon.id)
        .eq("group_id", groupId)
        .or("client_phone.not.is.null,client_email.not.is.null")
        .limit(1)
        .maybeSingle();
      if (lead?.id) {
        const sendAfter = new Date(Date.now() + 20_000).toISOString();
        const { error: enqErr } = await sr
          .from("scheduled_notifications")
          .insert({
            salon_id: ctx.salon.id,
            booking_id: String(lead.id),
            event: "cancel",
            channels: { sms: notifySms, email: notifyEmail },
            send_after: sendAfter,
          } as never);
        if (enqErr)
          console.error("[cancelDeskGroup] enqueue notify failed", enqErr);
      }
    } catch (e) {
      console.error("[cancelDeskGroup] notify", e);
    }
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
  if (ctx.salon.id !== String(input.salonId).trim())
    return fail("salon_mismatch");
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
    actorUserId: ctxActorUserId(ctx),
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
  if (ctx.salon.id !== String(input.salonId).trim())
    return fail("salon_mismatch");
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
    actorUserId: ctxActorUserId(ctx),
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
  input: {
    salonId: string;
    bookingId: string;
    /**
     * Per-mark fee decision (decision B — the desk chooses, we never silently
     * auto-bill):
     *   true      → charge the saved Square card-on-file now (idempotent).
     *   false     → waive: stamp 'waived' so the no-show tombstone shows the
     *               fee was intentionally skipped.
     *   undefined → leave the saved card untouched ('saved') so the desk can
     *               still collect later from the tombstone ("Chưa thu — bấm để
     *               thu"). The 1-tap overdue path lands here.
     */
    chargeFee?: boolean;
  },
): Promise<
  | {
      ok: true;
      charge?: { attempted: true; charged: boolean; reason: string };
    }
  | { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canMarkNoShow(ctx.role)) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim())
    return fail("salon_mismatch");
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const { data: updated, error: upErr } = await ctx.supabase
    .from("bookings")
    .update({ status: "no_show", no_show_candidate_at: null } as never)
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

  // Owner/admin "no-show" alert (opt-in, fire-and-forget).
  after(() =>
    sendOwnerBookingNotification({
      salonId: ctx.salon.id,
      bookingId,
      event: "no_show",
    }),
  );

  // These two RPCs are SECURITY DEFINER + revoked from anon/authenticated, so
  // they're invoked with the service-role client AFTER the role/salon auth above
  // (never directly callable by an untrusted user).
  const svc = createServiceRoleClient();

  // Feed the no-show risk engine — best-effort, never fail the desk action on this.
  if (updated.client_phone) {
    const { error: bumpErr } = await svc.rpc("bump_client_no_show", {
      p_phone: updated.client_phone,
    });
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
      const { notifyWaitlistForSlot } =
        await import("@/shared/noshow/waitlistAutoFill");
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

  // No-show fee — the desk decides per-mark whether to collect (decision B).
  // Idempotent (stable idempotency key) + best-effort; never fail the desk action.
  let chargeResult:
    { attempted: true; charged: boolean; reason: string } | undefined;
  if (input.chargeFee === true) {
    try {
      const { chargeNoShowFee } =
        await import("@/shared/integrations/square/noshow");
      const result = await chargeNoShowFee(bookingId);
      chargeResult = {
        attempted: true,
        charged: result.charged,
        reason: result.reason,
      };
    } catch (e) {
      console.error("[markNoShowBooking] noshow-fee", e);
      chargeResult = {
        attempted: true,
        charged: false,
        reason: "charge_failed",
      };
    }
  } else if (input.chargeFee === false) {
    // Waive — stamp 'waived' when a card is on file and nothing's been charged
    // yet, so the tombstone reads as a deliberate skip (not an unbilled debt).
    const { error: waiveErr } = await ctx.supabase
      .from("bookings")
      .update({ noshow_charge_status: "waived" } as never)
      .eq("id", bookingId)
      .eq("salon_id", ctx.salon.id)
      .not("noshow_card_id", "is", null)
      .neq("noshow_charge_status", "charged");
    if (waiveErr) console.error("[markNoShowBooking] waive", waiveErr);
  }

  // Win-back — a friendly "we missed you, rebook" email (retention over
  // penalty). Opt-out via salons.winback_enabled. Best-effort, off the response
  // path; never fails the desk action.
  const winbackEmail = (updated as { client_email?: string | null })
    .client_email;
  if (winbackEmail && winbackEmail.trim()) {
    const clientName = String(
      (updated as { client_name?: string | null }).client_name ?? "",
    );
    const svcName = String(
      (updated as { services?: { name?: string | null } | null }).services
        ?.name ?? "",
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
        const { sendWinBackEmail } =
          await import("@/shared/noshow/sendWinBackEmail");
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
    actorUserId: ctxActorUserId(ctx),
    actorRole: ctxActorRole(ctx),
    eventType: "booking_status_changed",
    payload: {
      to: "no_show",
      reason: "desk_no_show",
      fee:
        input.chargeFee === true
          ? chargeResult?.charged
            ? "charged"
            : "failed"
          : input.chargeFee === false
            ? "waived"
            : "deferred",
    },
  });
  return { ok: true, ...(chargeResult ? { charge: chargeResult } : {}) };
}

/**
 * Undo a no-show — the customer was just running late after all. Reverts
 * `no_show` → `confirmed` and decrements the client's no_show_count (so a
 * wrongly-marked guest isn't penalised). Same
 * front-desk roles as marking.
 */
export async function undoNoShowBooking(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canMarkNoShow(ctx.role)) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim())
    return fail("salon_mismatch");
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");
  // Rollout-safe enforcement: once archived recovery is enabled, no_show is a
  // terminal audit fact. A late guest gets a new linked walk-in instead.
  const immutable = await terminalBookingMustRemainImmutable(
    ctx.salon.id,
    bookingId,
  );
  if (!immutable.ok) return fail("server_error");
  if (immutable.immutable) {
    return fail("immutable_terminal_state");
  }

  const { data: updated, error: upErr } = await ctx.supabase
    .from("bookings")
    .update({ status: "confirmed", no_show_candidate_at: null } as never)
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
    actorUserId: ctxActorUserId(ctx),
    actorRole: ctxActorRole(ctx),
    eventType: "booking_status_changed",
    payload: { to: "confirmed", reason: "undo_no_show" },
  });
  return { ok: true };
}

/**
 * Collect the saved no-show fee on demand — for a booking already marked
 * `no_show` whose card was left uncharged because the desk deferred the fee
 * decision. Idempotent: `chargeNoShowFee` guards a
 * stable Square idempotency key + a 'charged' status check, so double-taps and
 * retries never double-bill. Front-desk roles only; audit-logged.
 */
export async function chargeNoShowFeeManual(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<
  { ok: true; charged: boolean; reason: string } | { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canMarkNoShow(ctx.role)) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim())
    return fail("salon_mismatch");
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  // Gate on the row first — only a no_show booking in THIS salon is chargeable
  // here. chargeNoShowFee itself is salon-agnostic + idempotent, so the row
  // check is what scopes the action to the authenticated desk.
  const { data: row } = await ctx.supabase
    .from("bookings")
    .select("id, status, noshow_charge_status")
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (!row?.id) return fail("invalid_booking");
  if ((row as { status?: string }).status !== "no_show")
    return fail("invalid_state");

  try {
    const { chargeNoShowFee } =
      await import("@/shared/integrations/square/noshow");
    // A RETRY of a previously-failed charge needs a fresh idempotency suffix,
    // else Square replays the original decline instead of re-attempting (the
    // card may since have funds). First-time charges keep the stable key.
    const isRetry =
      (row as { noshow_charge_status?: string }).noshow_charge_status ===
      "failed";
    const res = await chargeNoShowFee(
      bookingId,
      isRetry ? { idempotencySuffix: crypto.randomUUID() } : undefined,
    );
    void logBookingEvent({
      bookingId,
      salonId: ctx.salon.id,
      actorUserId: ctxActorUserId(ctx),
      actorRole: ctxActorRole(ctx),
      eventType: "booking_status_changed",
      payload: {
        reason: "desk_charge_noshow_fee",
        charged: res.charged,
        detail: res.reason,
      },
    });
    return { ok: true, charged: res.charged, reason: res.reason };
  } catch (e) {
    console.error("[chargeNoShowFeeManual]", e);
    return fail("server_error");
  }
}

/**
 * Waive the saved no-show fee — stamp 'waived' so the tombstone reflects a
 * deliberate skip (e.g. a loyal guest who was just late). Does NOT refund an
 * already-charged fee (a charged card is a Square-side refund, out of scope).
 * Front-desk roles only; audit-logged.
 */
export async function waiveNoShowFee(
  slug: string,
  input: { salonId: string; bookingId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canMarkNoShow(ctx.role)) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim())
    return fail("salon_mismatch");
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const { data: updated, error: upErr } = await ctx.supabase
    .from("bookings")
    .update({ noshow_charge_status: "waived" } as never)
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .eq("status", "no_show")
    .neq("noshow_charge_status", "charged")
    .select("id")
    .maybeSingle();
  if (upErr) {
    console.error("[waiveNoShowFee]", upErr);
    return fail("server_error");
  }
  if (!updated?.id) return fail("invalid_state");

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: ctxActorUserId(ctx),
    actorRole: ctxActorRole(ctx),
    eventType: "booking_status_changed",
    payload: { reason: "desk_waive_noshow_fee" },
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
  if (ctx.salon.id !== String(input.salonId).trim())
    return fail("salon_mismatch");
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");

  const priceCents = Math.round(Number(input.priceCents));
  if (
    !Number.isFinite(priceCents) ||
    priceCents < 0 ||
    priceCents > 100_000_00
  ) {
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
    actorUserId: ctxActorUserId(ctx),
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
  if (ctx.salon.id !== String(input.salonId).trim())
    return fail("salon_mismatch");
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");
  // The confirmation dialog is the correction boundary. After cancellation,
  // preserve the original row and create a linked replacement if needed.
  const immutable = await terminalBookingMustRemainImmutable(
    ctx.salon.id,
    bookingId,
  );
  if (!immutable.ok) return fail("server_error");
  if (immutable.immutable) {
    return fail("immutable_terminal_state");
  }

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

  // The booking is restored → cancel any still-pending cancel notification so
  // the customer is never texted about a cancel that was undone.
  {
    const sr = createServiceRoleClient();
    const { error: cancelErr } = await sr
      .from("scheduled_notifications")
      .update({ status: "cancelled" } as never)
      .eq("booking_id", bookingId)
      .eq("event", "cancel")
      .eq("status", "pending");
    if (cancelErr)
      console.error(
        "[undoCancelBooking] cancel pending notify failed",
        cancelErr,
      );
  }

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: ctxActorUserId(ctx),
    actorRole: ctxActorRole(ctx),
    eventType: "booking_restored",
    payload: { reason: "undo_cancel" },
  });

  return { ok: true };
}

/**
 * Restore a cancelled booking back to "confirmed".
 * Guards:
 *   - Front-desk roles only: owner / admin / senior / receptionist (canUndoCancel)
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
  if (ctx.salon.id !== String(input.salonId).trim())
    return fail("salon_mismatch");
  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId || !isUuidLike(bookingId)) return fail("invalid_booking");
  const immutable = await terminalBookingMustRemainImmutable(
    ctx.salon.id,
    bookingId,
  );
  if (!immutable.ok) return fail("server_error");
  if (immutable.immutable) {
    return fail("immutable_terminal_state");
  }

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
    actorUserId: ctxActorUserId(ctx),
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
    { role: ctxActorRole(ctx), userId: ctxActorUserId(ctx) },
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
    recovery?: ArchivedBookingRecoveryInput;
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
    recovery: input.recovery,
  });
  if (!created.ok) return created;

  // Recovery is deliberately one atomic outcome: create a linked WAITING
  // walk-in. Immediate assignment is a second mutation that can fail after the
  // durable row exists, making the UI report failure for a successful create.
  // The desk assigns the visible queue card in the normal next step.
  if (input.recovery || !autoAssign) {
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

  const requested = Number.isFinite(input.minutes)
    ? Math.round(input.minutes!)
    : SOFT_HOLD_DEFAULT_MINUTES;
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
    actorUserId: ctxActorUserId(ctx),
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
  input: {
    salonId: string;
    bookingId: string;
    reason?: "expired" | "returned";
  },
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
    actorUserId: ctxActorUserId(ctx),
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
/**
 * Returns each active resource (bed/chair) with a real-time availability flag
 * for the given UTC window. Used by the desk bed-picker dropdown.
 * Pass `excludeBookingId` when editing an existing booking so self-conflict is ignored.
 */
export async function getResourceAvailability(
  slug: string,
  startUtcIso: string,
  endUtcIso: string,
  excludeBookingId?: string,
): Promise<
  | {
      ok: true;
      resources: {
        id: string;
        name: string;
        displayOrder: number;
        isAvailable: boolean;
      }[];
    }
  | { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  const db = createServiceRoleClient();
  const { data: resRows } = await db
    .from("salon_resources" as never)
    .select("id, name, display_order")
    .eq("salon_id" as never, ctx.salon.id)
    .eq("status" as never, "active")
    .is("deleted_at" as never, null)
    .order("display_order" as never, { ascending: true });
  const rows = (resRows ?? []) as {
    id: string;
    name: string;
    display_order: number;
  }[];
  if (rows.length === 0) return { ok: true, resources: [] };

  const { data: conflicts } = await db
    .from("bookings")
    .select("id, resource_id")
    .in(
      "resource_id",
      rows.map((r) => r.id),
    )
    .not("status", "in", "(cancelled,waiting,no_show)")
    .lt("start_time_utc", endUtcIso)
    .gt("end_time_utc", startUtcIso);

  const busyIds = new Set<string>(
    (conflicts ?? [])
      .filter(
        (c) =>
          !excludeBookingId || (c as { id: string }).id !== excludeBookingId,
      )
      .map((c) => (c as { resource_id: string }).resource_id),
  );

  return {
    ok: true,
    resources: rows.map((r) => ({
      id: r.id,
      name: r.name,
      displayOrder: r.display_order,
      isAvailable: !busyIds.has(r.id),
    })),
  };
}

export async function getDeskBookingData(slug: string): Promise<
  | {
      ok: true;
      data: NonNullable<
        Awaited<ReturnType<typeof loadBookingServicesForSalonSlug>>
      > & { canBookAfterHours: boolean };
    }
  | { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (!canCreateDeskBooking(ctx.role)) return fail("unauthorized");
  const data = await loadBookingServicesForSalonSlug(slug);
  if (!data) return fail("not_found");
  return {
    ok: true,
    data: {
      ...data,
      // Demo-cookie owners have no attributable auth user and therefore cannot
      // approve an auditable labor-hours exception.
      canBookAfterHours:
        ctx.kind === "member" &&
        ctx.userId != null &&
        canCreateAfterHoursDeskBooking(ctx.role),
    },
  };
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
    /** Optional sequential/concurrent add-ons (is_addon services). Extend the
     *  appointment block exactly like the public flow so we never undercount
     *  duration and overlap the next booking. */
    addonServiceIds?: string[];
    /** Staff UUID, or BOOKING_ANY_STAFF_ID ("any") to auto-assign the best free
     *  capable provider — same picker as public/voice bookings. */
    staffId: string;
    /** Stamp the ❤️ "customer requested this tech" flag (heart icon + report). */
    staffRequestedByClient?: boolean;
    /** YYYY-MM-DD in salon-local time. */
    bookingDateYmd: string;
    /** Time-slot label as rendered by the grid, e.g. "9:00 AM". */
    timeSlot: string;
    clientName: string;
    clientPhone: string;
    clientEmail?: string | null;
    clientNotes?: string | null;
    language?: "en" | "vi";
    /** Which channels to confirm the booking on. Omitted → both (legacy
     *  behavior). The form's notify panel passes the receptionist's choice. */
    notify?: { sms?: boolean; email?: boolean };
    /** Explicit bed/chair to assign. `null` = auto-assign first free one.
     *  `undefined` = also auto-assign (backwards compat). */
    resourceId?: string | null;
    /** Management-only exception. The server independently proves the acting
     * role, selected staff, time boundary, and 120-minute cap. */
    afterHoursOverride?: {
      staffConsentConfirmed?: boolean;
    };
    /** Creates a new appointment linked to an immutable cancelled source. */
    recovery?: ArchivedBookingRecoveryInput;
  },
): Promise<OkDeskBooking | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return fail("unauthorized");
  if (ctx.salon.id !== String(input.salonId).trim())
    return fail("salon_mismatch");
  if (!canCreateDeskBooking(ctx.role)) return fail("unauthorized");

  const recoveryResult = await validateArchivedBookingRecovery(
    ctx,
    input.recovery,
    "cancelled_rebook",
  );
  if (!recoveryResult.ok) return recoveryResult;
  const recovery = recoveryResult.recovery;
  if (recoveryResult.existingBookingId) {
    return { ok: true, bookingId: recoveryResult.existingBookingId };
  }

  const clientName = String(input.clientName ?? "").trim();
  if (!clientName || clientName.length > BOOKING_GUEST_NAME_MAX)
    return fail("invalid_name");
  if (!isValidCustomerName(clientName)) return fail("invalid_name_chars");

  const phoneOk = validateGuestPhone(String(input.clientPhone ?? "").trim());
  if (!phoneOk.ok) return fail("invalid_phone");
  const canonicalPhone = toCanonicalPhone(phoneOk.digits) ?? phoneOk.digits;

  const serviceId = String(input.serviceId ?? "").trim();
  if (!isUuidLike(serviceId)) return fail("invalid_service");

  // Staff may be a real UUID or the "any available" sentinel.
  const rawStaffId = String(input.staffId ?? "").trim();
  const isAnyStaff = rawStaffId === BOOKING_ANY_STAFF_ID;
  if (!isAnyStaff && !isUuidLike(rawStaffId)) return fail("invalid_staff");

  const dateYmd = String(input.bookingDateYmd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) return fail("invalid_date");

  const startMinutes = parseTimeSlotToMinutes(String(input.timeSlot ?? ""));
  if (!Number.isFinite(startMinutes) || startMinutes < 0)
    return fail("invalid_time");

  let clientEmail: string | null = null;
  const emailRaw = String(input.clientEmail ?? "").trim();
  if (emailRaw) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw))
      return fail("invalid_email");
    clientEmail = emailRaw.toLowerCase();
  }
  const clientNotes =
    String(input.clientNotes ?? "")
      .trim()
      .slice(0, 500) || null;

  // De-dupe + sanitize add-on ids; an add-on can't be the main service.
  const addonIds: string[] = Array.isArray(input.addonServiceIds)
    ? Array.from(
        new Set(
          input.addonServiceIds.map((s) => String(s).trim()).filter(isUuidLike),
        ),
      )
    : [];
  if (addonIds.includes(serviceId)) return fail("invalid_addon");

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
    .select(
      "name, duration_minutes, buffer_minutes, price_cents, salon_id, deleted_at",
    )
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
  if (!svc || svc.salon_id !== ctx.salon.id || svc.deleted_at)
    return fail("invalid_service");
  const mainDuration = Math.round(Number(svc.duration_minutes ?? 0));
  const mainBuffer = Math.round(Number(svc.buffer_minutes ?? 0));
  if (!Number.isFinite(mainDuration) || mainDuration < 1)
    return fail("invalid_duration");
  if (!Number.isFinite(mainBuffer) || mainBuffer < 0)
    return fail("invalid_buffer");

  // Resolve active promotion discount for this service (server-side, no client trust)
  const basePriceCents =
    svc.price_cents != null ? Math.round(Number(svc.price_cents)) : null;
  let deskPriceCents = basePriceCents;
  let deskPromoId: string | null = null;

  if (basePriceCents) {
    const nowIso = new Date().toISOString();
    const { data: activePromos } = await db
      .from("promotions" as never)
      .select("id, name, discount_type, discount_value, applies_to")
      .eq("salon_id" as never, ctx.salon.id)
      .eq("active" as never, true)
      .lte("starts_at" as never, nowIso)
      .gte("ends_at" as never, nowIso);

    const promoList = (activePromos ?? []) as {
      id: string;
      name: string;
      discount_type: string;
      discount_value: number;
      applies_to: string;
    }[];

    if (promoList.length > 0) {
      const promoIds = promoList.map((p) => p.id);
      const { data: svcRules } = await db
        .from("promotion_services" as never)
        .select("promotion_id, discount_type, discount_value")
        .in("promotion_id" as never, promoIds)
        .eq("service_id" as never, serviceId);

      const ruleMap = new Map<
        string,
        { discount_type: string; discount_value: number }
      >();
      for (const r of (svcRules ?? []) as {
        promotion_id: string;
        discount_type: string | null;
        discount_value: number | null;
      }[]) {
        if (r.discount_type && r.discount_value != null)
          ruleMap.set(r.promotion_id, {
            discount_type: r.discount_type,
            discount_value: r.discount_value,
          });
      }

      let bestDiscount = 0;
      for (const p of promoList) {
        const rule = ruleMap.get(p.id);
        let dtype: string;
        let dvalue: number;
        if (rule) {
          dtype = rule.discount_type;
          dvalue = rule.discount_value;
        } else if (p.applies_to === "all") {
          dtype = p.discount_type;
          dvalue = p.discount_value;
        } else continue;

        let disc = 0;
        if (dtype === "fixed_price")
          disc = Math.max(0, basePriceCents - dvalue);
        else if (dtype === "amount") disc = Math.min(dvalue, basePriceCents);
        else if (dtype === "percent")
          disc = Math.round((basePriceCents * dvalue) / 10000);

        if (disc > bestDiscount) {
          bestDiscount = disc;
          deskPromoId = p.id;
          deskPriceCents = Math.max(0, basePriceCents - disc);
        }
      }
    }
  }

  // Add-on durations extend the block (concurrent ones add $0 time); prices sum
  // into the email total. Validated server-side: must be this salon's live,
  // is_addon services — never trust client durations/prices.
  let addonBlockMin = 0;
  const timingAddOns: BookingTimingSegment[] = [];
  let addonPriceCents = 0;
  // Display rows for the optimistic grid item (`bookingsForDay[].addons`) — same
  // shape `loadReceptionistCenterData` builds from `booking_addons`.
  const optimisticAddons: {
    name: string;
    price_cents: number | null;
    duration_minutes: number;
    concurrent: boolean;
  }[] = [];
  // First add-on, for the legacy single-addon columns on the grid item.
  let firstAddon: {
    id: string;
    name: string;
    price_cents: number | null;
    duration_minutes: number;
    buffer_minutes: number;
  } | null = null;
  if (addonIds.length > 0) {
    const { data: addRows } = await db
      .from("services")
      .select(
        "id, name, duration_minutes, buffer_minutes, price_cents, is_addon, addon_timing, salon_id, deleted_at",
      )
      .in("id", addonIds);
    const byId = new Map(
      (addRows ?? []).map((r) => [String((r as { id: string }).id), r]),
    );
    for (const id of addonIds) {
      const a = byId.get(id) as
        | {
            name?: string | null;
            duration_minutes?: number | null;
            buffer_minutes?: number | null;
            price_cents?: number | null;
            is_addon?: unknown;
            addon_timing?: unknown;
            salon_id?: string;
            deleted_at?: string | null;
          }
        | undefined;
      if (
        !a ||
        a.salon_id !== ctx.salon.id ||
        a.deleted_at ||
        a.is_addon !== true
      ) {
        return fail("invalid_addon");
      }
      const block = serviceBlockMinutes(a.duration_minutes, a.buffer_minutes);
      if (block <= 0) return fail("invalid_addon");
      const concurrent = a.addon_timing === "concurrent";
      if (!concurrent) addonBlockMin += block;
      timingAddOns.push({
        durationMinutes: a.duration_minutes,
        bufferMinutes: a.buffer_minutes,
        concurrent,
      });
      addonPriceCents += a.price_cents != null ? Number(a.price_cents) : 0;
      const addonName = String(a.name ?? "");
      const addonDuration = Math.max(
        0,
        Math.round(Number(a.duration_minutes) || 0),
      );
      const addonPrice = a.price_cents != null ? Number(a.price_cents) : null;
      optimisticAddons.push({
        name: addonName,
        price_cents: addonPrice,
        duration_minutes: addonDuration,
        concurrent,
      });
      if (!firstAddon) {
        firstAddon = {
          id,
          name: addonName,
          price_cents: addonPrice,
          duration_minutes: addonDuration,
          buffer_minutes: Math.max(
            0,
            Math.round(Number(a.buffer_minutes) || 0),
          ),
        };
      }
    }
  }

  const timezone = ctx.salon.timezone;
  const startUtcIso = salonWallTimeToUtcIso(dateYmd, startMinutes, timezone);
  const bookingTiming = computeBookingTiming(
    {
      durationMinutes: mainDuration,
      bufferMinutes: mainBuffer,
    },
    timingAddOns,
  );
  const totalMin = bookingTiming.blockMinutes;
  // Keep the accumulator honest while legacy add-on persistence still uses it.
  if (
    totalMin !==
    serviceBlockMinutes(mainDuration, mainBuffer) + addonBlockMin
  ) {
    return fail("invalid_duration");
  }
  const serviceCompletionMinutes =
    addonIds.length <= 1
      ? bookingTiming.serviceCompletionMinutes
      : bookingTiming.blockMinutes;
  const hoursCheck = checkBookingWithinOpeningHours({
    openingHoursRaw: ctx.salon.opening_hours,
    bookingClosedDatesRaw: ctx.salon.booking_closed_dates,
    dateYmd,
    startMinutes,
    serviceCompletionMinutes,
  });
  let afterHoursMinutes: number | null = null;
  if (!hoursCheck.ok) {
    if (
      ctx.kind !== "member" ||
      !ctx.userId ||
      !canCreateAfterHoursDeskBooking(ctx.role)
    ) {
      return fail("after_hours_not_allowed");
    }
    if (isAnyStaff) return fail("specific_staff_required");
    if (input.afterHoursOverride?.staffConsentConfirmed !== true) {
      return fail("staff_consent_required");
    }
    const override = evaluateControlledAfterHours({
      openingHoursRaw: ctx.salon.opening_hours,
      bookingClosedDatesRaw: ctx.salon.booking_closed_dates,
      dateYmd,
      startMinutes,
      serviceCompletionMinutes,
    });
    if (!override.ok) {
      return fail(
        override.reason === "extension_too_long"
          ? "after_hours_limit_exceeded"
          : "outside_hours",
      );
    }
    afterHoursMinutes = override.afterHoursMinutes;
  } else if (input.afterHoursOverride) {
    // Never stamp a normal booking as after-hours merely because a client sent
    // the optional object.
    return fail("invalid_after_hours_override");
  }
  const endUtcIso = new Date(
    Date.parse(startUtcIso) + totalMin * 60_000,
  ).toISOString();
  const slotStartMs = Date.parse(startUtcIso);
  const slotEndMs = Date.parse(endUtcIso);

  // Reject past-time bookings (defense-in-depth). The client grid already hides
  // past slots, but a stale client — or a receptionist whose DEVICE is in a
  // timezone ahead of the salon, so the form defaulted to the wrong day — must
  // never be able to create an appointment in the past. 60s grace absorbs clock
  // skew; anything older (e.g. a 9 AM slot picked at 4 PM) is refused.
  if (Number.isFinite(slotStartMs) && slotStartMs < Date.now() - 60_000) {
    return fail("time_in_past");
  }

  // Resolve the staff to book. ALWAYS restrict to active + capable providers so
  // we mirror the public slot grid and never oversell via an inactive staff row.
  // The booking must be doable for the main service AND every add-on.
  const requiredServiceIds = [serviceId, ...addonIds];
  const { data: staffRows } = await db
    .from("staff")
    .select("id, name, salon_id, status")
    .eq("salon_id", ctx.salon.id)
    .eq("status", "active")
    .is("deleted_at" as never, null)
    .order("name", { ascending: true });
  const activeStaff = (staffRows ?? []).map((r) => ({
    id: String((r as { id: string }).id),
    name: String((r as { name?: string }).name ?? ""),
  }));
  const { data: capRows } = await db
    .from("staff_services")
    .select("staff_id, service_id")
    .in(
      "staff_id",
      activeStaff.map((s) => s.id),
    );
  const capability = buildCapabilityMap(
    (capRows ?? []).map((r) => ({
      staff_id: String((r as { staff_id: string }).staff_id),
      service_id: String((r as { service_id: string }).service_id),
    })),
  );
  const capableStaff = filterStaffCapableForServices(
    activeStaff,
    capability,
    requiredServiceIds,
  );
  if (capableStaff.length === 0) return fail("no_staff_available");

  let resolvedStaffId: string;
  let staffName = "";
  if (isAnyStaff) {
    // Auto-assign: pick the freest capable provider for this exact block.
    const range = salonDayRangeUtc(dateYmd, timezone);
    const { data: occRaw } = await db.rpc(
      "public_booking_occupancy_for_range",
      {
        p_salon_id: ctx.salon.id,
        p_start: range.startUtc,
        p_end: range.endUtc,
      } as never,
    );
    const occupancy = (Array.isArray(occRaw) ? occRaw : []).map((row) => ({
      staffId: String((row as { staff_id: string }).staff_id),
      startMs: Date.parse((row as { start_time_utc: string }).start_time_utc),
      endMs: Date.parse((row as { end_time_utc: string }).end_time_utc),
    }));
    const freeIds = capableStaff
      .map((s) => s.id)
      .filter(
        (id) =>
          !occupancy.some(
            (o) =>
              o.staffId === id &&
              intervalsOverlapMs(slotStartMs, slotEndMs, o.startMs, o.endMs),
          ),
      );
    if (freeIds.length === 0) return fail("time_slot_taken");
    resolvedStaffId = pickBestStaffAmongFree(
      freeIds,
      capableStaff,
      occupancy,
      Date.parse(range.startUtc),
      Date.parse(range.endUtc),
      slotStartMs,
    );
    staffName = capableStaff.find((s) => s.id === resolvedStaffId)?.name ?? "";
  } else {
    const chosen = capableStaff.find((s) => s.id === rawStaffId);
    if (!chosen) return fail("invalid_staff");
    resolvedStaffId = rawStaffId;
    staffName = chosen.name;
  }

  // Resource-mode salons: auto-assign a free resource (bed/chair) for this slot.
  let resolvedResourceId: string | null = null;
  const resMode = await getResourceMode(db, ctx.salon.id);
  if (resMode.enabled) {
    const rr = await resolveFreeResource(
      db,
      ctx.salon.id,
      startUtcIso,
      endUtcIso,
      input.resourceId ?? null,
    );
    if (!rr.resourceId) return fail("no_resource_available");
    resolvedResourceId = rr.resourceId;
  }

  let bookingId: string;
  if (afterHoursMinutes != null) {
    // The public RPC intentionally rejects out-of-hours times. This private
    // service-role insert is reached only after the authenticated management
    // checks above; the bookings GiST exclusion still rejects staff overlap.
    const { data: inserted, error: insertError } = await db
      .from("bookings")
      .insert({
        salon_id: ctx.salon.id,
        service_id: serviceId,
        staff_id: resolvedStaffId,
        client_name: clientName,
        client_phone: canonicalPhone,
        client_email: clientEmail,
        client_notes: clientNotes,
        client_locale: input.language ?? null,
        start_time_utc: startUtcIso,
        end_time_utc: endUtcIso,
        status: "confirmed",
        confirmed_at: new Date().toISOString(),
        source: "appointment",
        price_cents: deskPriceCents ?? svc.price_cents ?? null,
        walkin_source: "phone",
        booking_channel: "desk",
        staff_requested_by_client: input.staffRequestedByClient === true,
        resource_id: resolvedResourceId,
        after_hours_minutes: afterHoursMinutes,
        after_hours_approved_by: ctx.userId,
        after_hours_staff_consent: true,
        ...(recovery
          ? {
              recovered_from_booking_id: recovery.sourceBookingId,
              recovery_kind: recovery.kind,
              recovered_by_user_id: recovery.recoveredByUserId,
              idempotency_key: recovery.requestId,
            }
          : {}),
      } as never)
      .select("id")
      .single();
    if (insertError) {
      if ((insertError as { code?: string }).code === "23505" && recovery) {
        const raced = await loadExistingArchivedBookingRecovery(
          ctx.salon.id,
          recovery.sourceBookingId,
        );
        if (
          raced.ok &&
          raced.existing &&
          isSameArchivedBookingRecovery(raced.existing, recovery)
        ) {
          return { ok: true, bookingId: raced.existing.id };
        }
        return fail("already_recovered");
      }
      if ((insertError as { code?: string }).code === "23P01") {
        return fail("time_slot_taken");
      }
      console.error("[addDeskAppointment] after-hours insert", insertError);
      return fail("server_error");
    }
    bookingId = String((inserted as { id: string }).id);
  } else {
    const rpcName = recovery
      ? "create_recovered_booking"
      : "create_public_booking";
    const rpcArgs = recovery
      ? {
          p_source_booking_id: recovery.sourceBookingId,
          p_recovery_kind: recovery.kind,
          p_recovered_by_user_id: recovery.recoveredByUserId,
          p_idempotency_key: recovery.requestId,
          p_salon_id: ctx.salon.id,
          p_service_id: serviceId,
          p_staff_id: resolvedStaffId,
          p_client_name: clientName,
          p_client_phone: canonicalPhone,
          p_start_time_utc: startUtcIso,
          p_end_time_utc: endUtcIso,
          p_status: "confirmed",
          p_price_cents: deskPriceCents ?? svc.price_cents ?? null,
          p_client_notes: clientNotes,
          p_client_email: clientEmail,
          p_resource_id: resolvedResourceId,
        }
      : {
          p_salon_id: ctx.salon.id,
          p_service_id: serviceId,
          p_staff_id: resolvedStaffId,
          p_client_name: clientName,
          p_client_phone: canonicalPhone,
          p_start_time_utc: startUtcIso,
          p_end_time_utc: endUtcIso,
          p_status: "confirmed",
          p_price_cents: deskPriceCents ?? svc.price_cents ?? null,
          p_client_notes: clientNotes,
          p_client_email: clientEmail,
          p_resource_id: resolvedResourceId,
        };
    const { data: rpcData, error: rpcErr } = await db.rpc(
      rpcName as never,
      rpcArgs as never,
    );
    if (rpcErr) {
      const code = (rpcErr as { code?: string }).code;
      if (code === "P0002" || code === "23P01") return fail("time_slot_taken");
      console.error("[addDeskAppointment] rpc error", rpcErr);
      return fail("server_error");
    }
    const result = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as {
      success?: boolean;
      booking_id?: string;
      code?: string;
      replayed?: boolean;
    } | null;
    if (!result?.success || !result.booking_id) {
      const rCode = result?.code;
      if (rCode === "already_recovered") return fail("already_recovered");
      if (rCode === "invalid_recovery_source")
        return fail("invalid_recovery_source");
      if (rCode === "slot_conflict") return fail("time_slot_taken");
      if (rCode === "outside_hours") return fail("outside_hours");
      return fail("server_error");
    }
    bookingId = result.booking_id;
    if (recovery && result.replayed === true) {
      return { ok: true, bookingId };
    }
  }

  // Stamp promo discount when an active campaign applies (server-authoritative)
  if (
    deskPromoId &&
    basePriceCents &&
    deskPriceCents != null &&
    deskPriceCents < basePriceCents
  ) {
    try {
      await db
        .from("bookings")
        .update({
          promo_id: deskPromoId,
          original_price_cents: basePriceCents,
        } as never)
        .eq("id", bookingId);
    } catch {
      /* best-effort — booking exists with correct price, promo stamp is cosmetic */
    }
  }

  // Persist the full add-on list (durations/prices re-derived server-side by the
  // RPC). Best-effort — the appointment already exists with the correct block.
  if (addonIds.length > 0) {
    try {
      // Authenticated members deliberately cannot execute this cross-tenant
      // SECURITY DEFINER capability directly. This server action has already
      // authorized the salon and booking, so use the service-role client.
      const privilegedDb = createServiceRoleClient();
      const { error: addonError } = await privilegedDb.rpc(
        "add_booking_addons",
        {
          p_booking_id: bookingId,
          p_service_ids: addonIds,
        } as never,
      );
      if (addonError) {
        console.error("[addDeskAppointment] add_booking_addons", addonError);
      }
    } catch (error) {
      console.error("[addDeskAppointment] add_booking_addons", error);
      /* best-effort */
    }
  }

  // Track the phone-in channel (best-effort; `source` stays 'appointment').
  // booking_channel = 'desk' marks this as a front-desk-entered appointment so
  // reports can separate it from online / Square / Wix. The ❤️ staff-request
  // flag is stamped in the same round-trip when the receptionist ticks it.
  try {
    const channelUpdate: Record<string, unknown> = {
      walkin_source: "phone",
      booking_channel: "desk",
    };
    if (input.staffRequestedByClient === true) {
      channelUpdate.staff_requested_by_client = true;
    }
    await db
      .from("bookings")
      .update(channelUpdate as never)
      .eq("id", bookingId);
  } catch {
    /* best-effort */
  }

  // The admin initiating a recovery is already looking at the result. Suppress
  // the redundant owner alert; this also keeps QA recovery runs outbound-free.
  if (!recovery) {
    after(() =>
      sendOwnerBookingNotification({
        salonId: ctx.salon.id,
        bookingId,
        event: "new",
      }),
    );
  }

  void logBookingEvent({
    bookingId,
    salonId: ctx.salon.id,
    actorUserId: ctxActorUserId(ctx),
    actorRole: ctxActorRole(ctx),
    eventType:
      afterHoursMinutes != null
        ? "booking_after_hours_created"
        : "booking_created",
    payload: {
      source: "desk_phone",
      staffId: resolvedStaffId,
      serviceId,
      addonServiceIds: addonIds,
      anyStaff: isAnyStaff,
      staffRequestedByClient: input.staffRequestedByClient === true,
      ...(afterHoursMinutes != null
        ? {
            afterHoursMinutes,
            staffConsentConfirmed: true,
            approvedBy: ctx.userId,
          }
        : {}),
      ...(recovery
        ? {
            recoveredFromBookingId: recovery.sourceBookingId,
            recoveryKind: recovery.kind,
          }
        : {}),
    },
  });

  if (recovery) {
    void logBookingEvent({
      bookingId,
      salonId: ctx.salon.id,
      actorUserId: ctxActorUserId(ctx),
      actorRole: ctxActorRole(ctx),
      eventType: "booking_recovered",
      payload: {
        sourceBookingId: recovery.sourceBookingId,
        recoveryKind: recovery.kind,
      },
    });
  }

  // Unified no-show protection gate: a desk/phone booking skips the online card
  // capture, so flag "needs card" the same way every other path does. Flag
  // only — the desk decides whether to text the save-card link.
  await handleBookingProtection(bookingId, ctx.salon.id, "desk");

  // Confirmation to the customer, gated by the receptionist's notify choice
  // (legacy callers without `notify` keep the always-send behavior). Reuses the
  // existing rich SMS + email confirmation routes.
  // Recovery is outbound-off by default on the server too. A stale or forged
  // caller that omits `notify` must not inherit the legacy "send both"
  // behavior; an owner/admin may still explicitly opt into either channel.
  const notifyCreateSms = recovery
    ? input.notify?.sms === true
    : input.notify
      ? input.notify.sms === true
      : true;
  const notifyCreateEmail = recovery
    ? input.notify?.email === true
    : input.notify
      ? input.notify.email === true
      : true;
  const base =
    (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
  const serviceName = svc.name ?? "";
  const totalPriceCents =
    (deskPriceCents ?? svc.price_cents ?? 0) + addonPriceCents;
  after(async () => {
    if (notifyCreateSms) {
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
    }
    if (notifyCreateEmail && clientEmail) {
      const secret = (process.env.INTERNAL_API_SECRET ?? "").trim();
      try {
        await fetch(`${base}/api/booking-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": secret,
          },
          body: JSON.stringify({
            bookingId,
            shopSlug: slug,
            clientName,
            clientEmail,
            serviceName,
            staffName,
            startTimeUtc: startUtcIso,
            totalPriceCents,
          }),
        });
      } catch {
        /* best-effort */
      }
    }
  });

  // Build the optimistic grid row in the EXACT `bookingsForDay[number]` shape so
  // the client can splice it in for an instant render, then reconcile when the
  // background reload returns the canonical row (same id → replaced). Derived
  // flags mirror loadReceptionistCenterData's logic for a desk-created booking.
  const designRe = /(nail\s*art|design)/i;
  const mainServiceName = svc.name ?? "—";
  const hasDesignFlag =
    designRe.test(mainServiceName) ||
    optimisticAddons.some((a) => designRe.test(a.name));
  const optimisticBooking: DeskBookingRow = {
    id: bookingId,
    client_name: clientName,
    client_phone: canonicalPhone,
    client_email: clientEmail ?? null,
    client_locale: input.language ?? null,
    client_notes: clientNotes,
    staff_id: resolvedStaffId,
    start_time_utc: startUtcIso,
    end_time_utc: endUtcIso,
    status: "confirmed",
    source: "appointment",
    source_channel: "desk",
    // Desk-created now — stamp so the drawer's "Đặt lúc" line renders instantly
    // (reconciled by the canonical row on the background reload).
    created_at: new Date().toISOString(),
    service_id: serviceId,
    service_name: mainServiceName,
    service_duration_minutes: Number(svc.duration_minutes ?? 0),
    price_cents: deskPriceCents ?? svc.price_cents ?? null,
    service_buffer_minutes: Math.max(
      0,
      Math.round(Number(svc.buffer_minutes ?? 0)),
    ),
    joined_queue_at: null,
    addon_service_id: firstAddon?.id ?? null,
    addon_service_name: firstAddon?.name ?? null,
    addon_duration_minutes: firstAddon?.duration_minutes ?? null,
    addon_buffer_minutes: firstAddon?.buffer_minutes ?? null,
    addon_price_cents: firstAddon?.price_cents ?? null,
    addons: optimisticAddons,
    client_no_show_count: 0,
    is_vip: false,
    has_notes: clientNotes != null && clientNotes.trim().length > 0,
    has_design: hasDesignFlag,
    has_staff_request: input.staffRequestedByClient === true,
    group_id: null,
    group_size: null,
    seat_together: false,
    verification_method: null,
    sms_confirmation_sent_at: null,
    sms_confirmation_failed_at: null,
    no_show_risk_score: null,
    no_show_candidate_at: null,
    deposit_status: null,
    deposit_amount_cents: null,
    wix_booking_id: null,
    // Desk-created booking has no card-on-file yet (no-show protection is
    // captured online for new/high-risk customers).
    noshow_card_id: null,
    // Flag is set server-side by ensureNoShowCardRequirement just after create;
    // the background reload reconciles the badge. Optimistic = not-yet-flagged.
    noshow_card_required: false,
    noshow_fee_cents: null,
    noshow_charge_status: null,
    resource_id: resolvedResourceId,
    resource_name: null,
    after_hours_minutes: afterHoursMinutes,
  };

  return { ok: true, bookingId, booking: optimisticBooking };
}

/** Origin the customer waitlist claim link is built on (same convention as
 *  waitlistAutoFill). Falls back to the production host. */
const WAITLIST_SITE_URL =
  (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";

/**
 * Receptionist "Invite now" — text a waitlisted online customer the claim link
 * the moment staff decide to offer them a slot. The customer joined
 * `booking_waitlist_entries` because their desired slot was full; this flips
 * the entry to `notified`, mints a claim token if needed, and SMSes the
 * 20-minute claim link via Twilio.
 *
 * Auth mirrors `cancelDeskBooking`: front-desk roles only
 * (owner/admin/senior/receptionist). Idempotent — re-inviting a `notified`
 * entry just re-sends with the same token. The SMS body is Vietnamese by
 * design (most salons are VN-facing) and ASCII-only so Twilio sends a single
 * GSM-7 segment.
 */
export async function inviteWaitlistEntry(
  slug: string,
  entryId: string,
): Promise<{ ok: boolean; suppressed?: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "forbidden" };
  // Same front-desk gate as cancelDeskBooking (owner/admin/senior/receptionist).
  if (!canCancelBooking(ctx.role)) return { ok: false, error: "forbidden" };

  const id = String(entryId ?? "").trim();
  if (!id || !isUuidLike(id)) return { ok: false, error: "not_found" };

  // Service-role: booking_waitlist_entries is RLS-locked. Load defensively by
  // id AND salon_id (tenant isolation) — never trust the id alone.
  const svc = createServiceRoleClient();
  const { data: entry, error: loadErr } = await svc
    .from("booking_waitlist_entries")
    .select(
      "id, service_id, client_name, client_phone, client_email, booking_date, claim_token, status, offered_staff_id, offered_start_utc",
    )
    .eq("id", id)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();

  if (loadErr) {
    console.error("[inviteWaitlistEntry] load", loadErr);
    return { ok: false, error: "server_error" };
  }
  const row = entry as {
    id: string;
    service_id: string | null;
    client_name: string | null;
    client_phone: string | null;
    client_email: string | null;
    booking_date: string | null;
    claim_token: string | null;
    status: string | null;
    offered_staff_id: string | null;
    offered_start_utc: string | null;
  } | null;
  if (!row?.id) return { ok: false, error: "not_found" };

  const phone = String(row.client_phone ?? "").trim();
  const inviteEmail = String(row.client_email ?? "").trim();
  // Need at least one channel to reach the customer (email is the resilient
  // fallback when US carriers filter the link-SMS).
  if (!phone && !inviteEmail) return { ok: false, error: "no_phone" };

  // Resolve service + salon names for the SMS copy.
  let serviceName = "";
  const serviceId = row.service_id ? String(row.service_id) : "";
  if (serviceId) {
    const { data: svcRow } = await svc
      .from("services")
      .select("name")
      .eq("id", serviceId)
      .eq("salon_id", ctx.salon.id)
      .maybeSingle();
    serviceName = String((svcRow as { name?: string } | null)?.name ?? "");
  }
  const salonName = String(ctx.salon.name ?? "").trim() || "NailIQ";
  const bookingDate = String(row.booking_date ?? "").slice(0, 10);

  // Idempotent token: reuse an existing one (re-invite) or mint a fresh one.
  const token = row.claim_token ?? crypto.randomUUID();

  const claimUrl = `${WAITLIST_SITE_URL}/booking/waitlist-claim?token=${token}`;

  // When the DB freed a concrete slot (offered_staff_id + offered_start_utc),
  // name the staff + time so the customer knows exactly what they're claiming.
  // Time is formatted in the salon tz (from ctx.salon.timezone, no extra query),
  // ASCII-only ("2:00 PM") so the body stays a single GSM-7 segment.
  let offeredSuffix = "";
  if (row.offered_staff_id && row.offered_start_utc) {
    const startMs = Date.parse(row.offered_start_utc);
    if (Number.isFinite(startMs)) {
      const { data: staffRow } = await svc
        .from("staff")
        .select("name")
        .eq("id", row.offered_staff_id)
        .maybeSingle();
      const staffName = String(
        (staffRow as { name?: string | null } | null)?.name ?? "",
      ).trim();
      if (staffName) {
        const timeZone = String(ctx.salon.timezone ?? "").trim() || "UTC";
        let time = "";
        try {
          time = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hour: "numeric",
            minute: "2-digit",
          }).format(new Date(startMs));
        } catch {
          time = "";
        }
        if (time) offeredSuffix = ` luc ${time} voi ${staffName}`;
      }
    }
  }

  // ASCII-only Vietnamese (no diacritics, no emoji) → single GSM-7 segment.
  const body = `${salonName}: Co cho trong ${serviceName} ngay ${bookingDate}${offeredSuffix}. Giu cho trong 20 phut: ${claimUrl}`;

  // Resolve the salon's notification language so the auto-appended opt-out line
  // matches it ('vi' → "Nhắn STOP để ngừng nhận tin."). Best-effort: any read
  // failure defaults to English. The VN-ASCII body above is fixed by design.
  let smsLang: "en" | "vi" = "en";
  let salonAddress: string | null = null;
  try {
    const { data: langRow } = await svc
      .from("salons")
      .select("default_notification_locale, address" as never)
      .eq("id", ctx.salon.id)
      .maybeSingle();
    const locale = String(
      (langRow as { default_notification_locale?: unknown } | null)
        ?.default_notification_locale ?? "",
    ).toLowerCase();
    smsLang = locale === "vi" ? "vi" : "en";
    salonAddress =
      (langRow as { address?: string | null } | null)?.address ?? null;
  } catch {
    /* default 'en' + email on */
  }

  // Send FIRST, then record. A suppressed send (dev/CI/test/fictional number)
  // returns ok:true and still counts as "handled". A genuine failure
  // (twilio_not_configured / Twilio error) must NOT mark the entry notified
  // ON ITS OWN — but a successful EMAIL still reaches the customer, so the
  // entry counts as notified if EITHER channel landed.
  const smsResult = phone
    ? await sendSmsReminder(phone, body, { lang: smsLang })
    : {
        ok: false,
        suppressed: false,
        messageSid: null as string | null,
        error: "no_phone",
      };

  // Parallel email channel — same claim link, resilient to US SMS link filtering.
  let emailOk = false;
  if (inviteEmail) {
    const er = await sendCustomerLinkEmail({
      email: inviteEmail,
      clientName: row.client_name,
      salonName,
      salonAddress,
      lang: smsLang,
      subject:
        smsLang === "en"
          ? `A spot opened up for your ${serviceName || "appointment"} · ${salonName}`
          : `Có chỗ trống cho ${serviceName || "lịch hẹn"} của bạn · ${salonName}`,
      bodyText:
        smsLang === "en"
          ? `Good news — a spot opened up${serviceName ? ` for ${serviceName}` : ""}${bookingDate ? ` on ${bookingDate}` : ""}. It's held for 20 minutes — claim it now.`
          : `Tin vui — vừa có chỗ trống${serviceName ? ` cho ${serviceName}` : ""}${bookingDate ? ` ngày ${bookingDate}` : ""}. Chỗ được giữ trong 20 phút — nhận ngay.`,
      ctaLabel: smsLang === "en" ? "Claim this spot" : "Nhận chỗ này",
      url: claimUrl,
      // The customer explicitly requested this availability alert when they
      // joined the waitlist, so treat the claim link as transactional.
      respectOptOut: false,
    });
    emailOk = er.ok;
  }

  // Log to booking_notifications (booking_id is null — the entry isn't a
  // booking yet). Best-effort; never fail the invite on a logging hiccup.
  try {
    await logNotification({
      bookingId: null,
      salonId: ctx.salon.id,
      notificationType: "waitlist_invite",
      channel: "sms",
      clientPhone: phone,
      messageSid: smsResult.messageSid ?? null,
      bodyPreview: body,
      ok: smsResult.ok,
      errorMessage: smsResult.ok ? null : (smsResult.error ?? null),
    });
  } catch (e) {
    console.error("[inviteWaitlistEntry] logNotification", e);
  }

  if (!smsResult.ok && !emailOk) {
    // Neither channel landed — nothing recorded, the row stays 'waiting'.
    return { ok: false, error: smsResult.error ?? "sms_failed" };
  }

  const { error: upErr } = await svc
    .from("booking_waitlist_entries")
    .update({
      status: "notified",
      notified_at: new Date().toISOString(),
      claim_token: token,
    } as never)
    .eq("id", id)
    .eq("salon_id", ctx.salon.id);
  if (upErr) {
    console.error("[inviteWaitlistEntry] update", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, suppressed: smsResult.suppressed };
}

// ─── deskClaimPartySlotAction ──────────────────────────────────────

export type DeskClaimResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "invalid_input"
        | "not_found"
        | "already_claimed"
        | "expired"
        | "server_error";
    };

/**
 * Receptionist quick-claim: assigns a name (and optional phone) to an unclaimed
 * party slot on behalf of a walk-in guest. Delegates atomicity to the same
 * `claim_party_slot` RPC used by the guest self-claim flow.
 *
 * Security: caller must be an authenticated salon member (getDashboardWriteClient).
 * The RPC itself validates the token + claim ID ownership.
 */
export async function deskClaimPartySlotAction(
  slug: string,
  claimId: string,
  token: string,
  memberName: string,
  memberPhone?: string,
): Promise<DeskClaimResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const nameTrim = memberName.trim();
  if (!nameTrim || nameTrim.length > BOOKING_GUEST_NAME_MAX) {
    return { ok: false, error: "invalid_input" };
  }

  const svc = createServiceRoleClient();

  // Validate the claim belongs to this salon before submitting.
  const { data: check } = await svc
    .from("party_link_claims")
    .select("id, party_links!inner(salon_id)")
    .eq("id", claimId)
    .maybeSingle();

  const salonId = (check?.party_links as unknown as { salon_id: string } | null)
    ?.salon_id;
  if (!check || salonId !== ctx.salon.id) {
    return { ok: false, error: "not_found" };
  }

  let phoneDigits: string | null = null;
  if (memberPhone?.trim()) {
    const phoneResult = validateGuestPhone(memberPhone.trim());
    if (!phoneResult.ok) return { ok: false, error: "invalid_input" };
    phoneDigits = phoneResult.digits;
  }

  const { data, error } = await svc.rpc("claim_party_slot", {
    p_token: token,
    p_claim_id: claimId,
    p_member_name: nameTrim,
    p_member_phone: phoneDigits,
    p_reminder_opted_in: false,
  });

  if (error) {
    Sentry.captureException(error, { extra: { slug, claimId } });
    return { ok: false, error: "server_error" };
  }

  const result = data as Record<string, unknown>;
  if (!result?.success) {
    const code = result?.code as string | undefined;
    if (code === "not_found") return { ok: false, error: "not_found" };
    if (code === "expired") return { ok: false, error: "expired" };
    if (code === "already_claimed")
      return { ok: false, error: "already_claimed" };
    return { ok: false, error: "server_error" };
  }

  return { ok: true };
}
