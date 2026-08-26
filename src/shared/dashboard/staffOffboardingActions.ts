"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { buildCapabilityMap, isStaffCapableForService } from "@/shared/booking/staffCapability";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const REASSIGNABLE = ["pending", "confirmed"] as const;
const BLOCKING = ["in_progress", "waiting"] as const;
const OPEN = [...REASSIGNABLE, ...BLOCKING] as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OpenStatus = (typeof OPEN)[number];

export type StaffOffboardingCandidate = {
  id: string;
  name: string;
};

export type StaffOffboardingBooking = {
  id: string;
  clientName: string;
  serviceName: string;
  startTimeUtc: string;
  endTimeUtc: string;
  status: OpenStatus;
  hasPhone: boolean;
  hasEmail: boolean;
  candidates: StaffOffboardingCandidate[];
};

export type StaffOffboardingPreview = {
  staffId: string;
  staffName: string;
  timezone: string;
  hasLogin: boolean;
  accessIsOwner: boolean;
  emailOutboundEnabled: boolean;
  smsOutboundEnabled: boolean;
  tooManyBookings: boolean;
  bookingLimit: number;
  bookings: StaffOffboardingBooking[];
};

export type StaffOffboardingResult =
  | {
      ok: true;
      reassigned: number;
      notificationEventsQueued: number;
      notificationDeliveriesQueued: number;
    }
  | { ok: false; error: string };

type RawBooking = {
  id: string;
  staff_id: string | null;
  service_id: string | null;
  addon_service_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  start_time_utc: string | null;
  end_time_utc: string | null;
  status: string;
  schedule_model: "single" | "segments_v1";
};

type RawSegment = {
  id: string;
  booking_id: string;
  line_id: string;
  service_id: string;
  staff_id: string;
  occupied_start_utc: string;
  occupied_end_utc: string;
  customer_start_utc: string;
  customer_end_utc: string;
  reservation_status: string;
  addon_lines: unknown;
};

type CapacityWindow = {
  bookingId: string;
  staffId: string;
  startTimeUtc: string;
  endTimeUtc: string;
  status: string;
};

type RawStaff = {
  id: string;
  name: string;
  status: string;
  user_id: string | null;
};

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function addonServiceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const serviceId = (item as Record<string, unknown>).service_id;
    return typeof serviceId === "string" && UUID_RE.test(serviceId)
      ? [serviceId]
      : [];
  });
}

function overlaps(leftStart: string, leftEnd: string, rightStart: string, rightEnd: string) {
  const leftStartMs = Date.parse(leftStart);
  const leftEndMs = Date.parse(leftEnd);
  const rightStartMs = Date.parse(rightStart);
  const rightEndMs = Date.parse(rightEnd);
  if ([leftStartMs, leftEndMs, rightStartMs, rightEndMs].some(Number.isNaN)) {
    return true;
  }
  return leftStartMs < rightEndMs && leftEndMs > rightStartMs;
}

async function loadPreviewData(
  admin: SupabaseClient,
  salonId: string,
  timezone: string,
  staffId: string,
): Promise<StaffOffboardingPreview | { error: string }> {
  const [{ data: staffRows, error: staffErr }, { data: salonRow, error: salonErr }] =
    await Promise.all([
      admin
        .from("staff")
        .select("id, name, status, user_id")
        .eq("salon_id", salonId)
        .is("deleted_at", null),
      admin
        .from("salons")
        .select("email_outbound_enabled, sms_outbound_enabled")
        .eq("id", salonId)
        .single(),
    ]);
  if (staffErr || salonErr || !salonRow) return { error: "server_error" };

  const staff = (staffRows ?? []) as RawStaff[];
  const target = staff.find((row) => row.id === staffId);
  if (!target) return { error: "not_found" };
  if (target.status === "inactive") return { error: "already_inactive" };

  const activeCandidates = staff.filter(
    (row) => row.id !== staffId && row.status === "active",
  );

  const { data: targetSegmentRows, error: segmentErr } = await admin
    .from("booking_service_segments")
    .select(
      "id, booking_id, line_id, service_id, staff_id, occupied_start_utc, occupied_end_utc, customer_start_utc, customer_end_utc, reservation_status, addon_lines",
    )
    .eq("salon_id", salonId)
    .eq("staff_id", staffId)
    .in("reservation_status", [...OPEN]);
  if (segmentErr) return { error: "server_error" };
  const targetSegments = (targetSegmentRows ?? []) as RawSegment[];
  const sequenceBookingIds = Array.from(
    new Set(targetSegments.map((row) => row.booking_id)),
  );

  const bookingColumns =
    "id, staff_id, service_id, addon_service_id, client_name, client_phone, client_email, start_time_utc, end_time_utc, status, schedule_model";
  const { data: parentStaffRows, error: parentStaffErr } = await admin
    .from("bookings")
    .select(bookingColumns)
    .eq("salon_id", salonId)
    .eq("staff_id", staffId)
    .in("status", [...OPEN])
    .is("deleted_at", null)
    .order("start_time_utc", { ascending: true });
  if (parentStaffErr) return { error: "server_error" };
  let sequenceParentRows: unknown[] = [];
  if (sequenceBookingIds.length > 0) {
    const { data, error } = await admin
      .from("bookings")
      .select(bookingColumns)
      .eq("salon_id", salonId)
      .in("id", sequenceBookingIds)
      .in("status", [...OPEN])
      .is("deleted_at", null);
    if (error) return { error: "server_error" };
    sequenceParentRows = data ?? [];
  }
  const bookingById = new Map<string, RawBooking>();
  for (const row of [...(parentStaffRows ?? []), ...sequenceParentRows] as RawBooking[]) {
    if (
      (row.schedule_model === "single" && row.staff_id === staffId) ||
      (row.schedule_model === "segments_v1" && sequenceBookingIds.includes(row.id))
    ) {
      bookingById.set(row.id, row);
    }
  }
  const openBookings = Array.from(bookingById.values()).sort((left, right) =>
    (left.start_time_utc ?? "").localeCompare(right.start_time_utc ?? ""),
  );

  const targetSegmentsByBooking = new Map<string, RawSegment[]>();
  for (const segment of targetSegments) {
    const bucket = targetSegmentsByBooking.get(segment.booking_id) ?? [];
    bucket.push(segment);
    targetSegmentsByBooking.set(segment.booking_id, bucket);
  }

  const serviceIds = Array.from(
    new Set(
      openBookings.flatMap((row) => {
        if (row.schedule_model === "segments_v1") {
          return (targetSegmentsByBooking.get(row.id) ?? []).flatMap((segment) => [
            segment.service_id,
            ...addonServiceIds(segment.addon_lines),
          ]);
        }
        return [row.service_id, row.addon_service_id].filter(
          (id): id is string => Boolean(id),
        );
      }),
    ),
  );
  const serviceNameById = new Map<string, string>();
  if (serviceIds.length > 0) {
    const { data: services, error: serviceErr } = await admin
      .from("services")
      .select("id, name")
      .eq("salon_id", salonId)
      .in("id", serviceIds);
    if (serviceErr) return { error: "server_error" };
    for (const row of (services ?? []) as Array<{ id: string; name: string }>) {
      serviceNameById.set(row.id, row.name);
    }
  }

  const allStaffIds = staff.map((row) => row.id);
  const { data: capabilityRows, error: capabilityErr } = allStaffIds.length
    ? await admin
        .from("staff_services")
        .select("staff_id, service_id")
        .in("staff_id", allStaffIds)
    : { data: [], error: null };
  if (capabilityErr) return { error: "server_error" };
  const capability = buildCapabilityMap(
    (capabilityRows ?? []) as Array<{ staff_id: string; service_id: string }>,
  );

  const existingCapacity: CapacityWindow[] = [];
  const candidateIds = activeCandidates.map((row) => row.id);
  if (candidateIds.length > 0 && openBookings.length > 0) {
    const affectedWindows = openBookings.flatMap((booking) =>
      booking.schedule_model === "segments_v1"
        ? (targetSegmentsByBooking.get(booking.id) ?? []).map((segment) => ({
            start: segment.occupied_start_utc,
            end: segment.occupied_end_utc,
          }))
        : booking.start_time_utc && booking.end_time_utc
          ? [{ start: booking.start_time_utc, end: booking.end_time_utc }]
          : [],
    );
    const starts = affectedWindows.map((row) => row.start);
    const ends = affectedWindows.map((row) => row.end);
    if (starts.length > 0 && ends.length > 0) {
      const minStart = starts.reduce((a, b) => (a < b ? a : b));
      const maxEnd = ends.reduce((a, b) => (a > b ? a : b));
      const [singleResult, segmentResult] = await Promise.all([
        admin
          .from("bookings")
          .select("id, staff_id, start_time_utc, end_time_utc, status")
          .eq("salon_id", salonId)
          .eq("schedule_model", "single")
          .in("staff_id", candidateIds)
          .is("deleted_at", null)
          .lt("start_time_utc", maxEnd)
          .gt("end_time_utc", minStart)
          .not("status", "in", '("cancelled","no_show","completed")'),
        admin
          .from("booking_service_segments")
          .select("booking_id, staff_id, occupied_start_utc, occupied_end_utc, reservation_status")
          .eq("salon_id", salonId)
          .in("staff_id", candidateIds)
          .lt("occupied_start_utc", maxEnd)
          .gt("occupied_end_utc", minStart)
          .not("reservation_status", "in", '("cancelled","no_show","completed")'),
      ]);
      if (singleResult.error || segmentResult.error) return { error: "server_error" };
      for (const row of (singleResult.data ?? []) as Array<{
        id: string;
        staff_id: string;
        start_time_utc: string;
        end_time_utc: string;
        status: string;
      }>) {
        existingCapacity.push({
          bookingId: row.id,
          staffId: row.staff_id,
          startTimeUtc: row.start_time_utc,
          endTimeUtc: row.end_time_utc,
          status: row.status,
        });
      }
      for (const row of (segmentResult.data ?? []) as Array<{
        booking_id: string;
        staff_id: string;
        occupied_start_utc: string;
        occupied_end_utc: string;
        reservation_status: string;
      }>) {
        existingCapacity.push({
          bookingId: row.booking_id,
          staffId: row.staff_id,
          startTimeUtc: row.occupied_start_utc,
          endTimeUtc: row.occupied_end_utc,
          status: row.reservation_status,
        });
      }
    }
  }

  let accessIsOwner = false;
  if (target.user_id) {
    const { data: member } = await admin
      .from("salon_members")
      .select("role")
      .eq("salon_id", salonId)
      .eq("user_id", target.user_id)
      .maybeSingle();
    accessIsOwner = (member as { role?: string } | null)?.role === "owner";
  }

  const bookings: StaffOffboardingBooking[] = openBookings.map((booking) => {
    const affectedSegments = targetSegmentsByBooking.get(booking.id) ?? [];
    const requiredServices = booking.schedule_model === "segments_v1"
      ? affectedSegments.flatMap((segment) => [
          segment.service_id,
          ...addonServiceIds(segment.addon_lines),
        ])
      : [booking.service_id, booking.addon_service_id].filter(
          (id): id is string => Boolean(id),
        );
    const affectedWindows = booking.schedule_model === "segments_v1"
      ? affectedSegments.map((segment) => ({
          start: segment.occupied_start_utc,
          end: segment.occupied_end_utc,
        }))
      : booking.start_time_utc && booking.end_time_utc
        ? [{ start: booking.start_time_utc, end: booking.end_time_utc }]
        : [];
    const candidates =
      booking.status === "pending" || booking.status === "confirmed"
        ? activeCandidates
            .filter((candidate) =>
              requiredServices.every((serviceId) =>
                isStaffCapableForService(capability, candidate.id, serviceId),
              ),
            )
            .filter((candidate) => {
              if (affectedWindows.length === 0) return false;
              return !affectedWindows.some((window) =>
                existingCapacity.some(
                  (existing) =>
                    existing.staffId === candidate.id &&
                    existing.status !== "cancelled" &&
                    existing.status !== "no_show" &&
                    existing.status !== "completed" &&
                    overlaps(
                      window.start,
                      window.end,
                      existing.startTimeUtc,
                      existing.endTimeUtc,
                    ),
                ),
              );
            })
            .map(({ id, name }) => ({ id, name }))
        : [];

    return {
      id: booking.id,
      clientName: booking.client_name?.trim() || "Guest",
      serviceName:
        booking.schedule_model === "segments_v1"
          ? Array.from(
              new Set(
                affectedSegments.map(
                  (segment) => serviceNameById.get(segment.service_id) || "Service",
                ),
              ),
            ).join(" + ") || "Service"
          : (booking.service_id && serviceNameById.get(booking.service_id)) ||
            "Service",
      startTimeUtc: booking.start_time_utc || "",
      endTimeUtc: booking.end_time_utc || "",
      status: booking.status as OpenStatus,
      hasPhone: Boolean(booking.client_phone?.trim()),
      hasEmail: Boolean(booking.client_email?.trim()),
      candidates,
    };
  });

  return {
    staffId,
    staffName: target.name,
    timezone,
    hasLogin: Boolean(target.user_id),
    accessIsOwner,
    emailOutboundEnabled: Boolean(
      (salonRow as { email_outbound_enabled?: boolean }).email_outbound_enabled,
    ),
    smsOutboundEnabled: Boolean(
      (salonRow as { sms_outbound_enabled?: boolean }).sms_outbound_enabled,
    ),
    tooManyBookings: bookings.length > 100,
    bookingLimit: 100,
    bookings,
  };
}

export async function loadStaffOffboardingPreview(
  slug: string,
  staffId: string,
  requestId?: string,
): Promise<
  | { ok: true; preview: StaffOffboardingPreview }
  | { ok: true; recovered: Extract<StaffOffboardingResult, { ok: true }> }
  | { ok: false; error: string }
> {
  if (!UUID_RE.test(staffId) || (requestId !== undefined && !UUID_RE.test(requestId))) {
    return fail("invalid_input");
  }
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) return fail("unauthorized");
  let admin: SupabaseClient;
  try {
    admin = createServiceRoleClient();
  } catch {
    return fail("server_error");
  }
  if (requestId) {
    const dbActorRole = ctx.kind === "demo_cookie" ? "demo_cookie" : ctx.role;
    const { data: recovery, error: recoveryError } = await admin.rpc(
      "recover_staff_offboarding_with_durable_notifications" as never,
      {
        p_salon_id: ctx.salon.id,
        p_staff_id: staffId,
        p_request_id: requestId,
        p_actor_user_id: ctx.userId,
        p_actor_role: dbActorRole,
      } as never,
    );
    if (recoveryError || !recovery || typeof recovery !== "object" || Array.isArray(recovery)) {
      console.error("[loadStaffOffboardingPreview] recovery", recoveryError);
      return fail("server_error");
    }
    const recovered = recovery as Record<string, unknown>;
    if (recovered.success === true) {
      const parsed = parseCompletedResult(recovered);
      return parsed.ok ? { ok: true, recovered: parsed } : parsed;
    }
    if (recovered.code !== "replay_not_found") {
      return fail(recovered.code === "idempotency_mismatch" ? recovered.code : "server_error");
    }
  }
  const preview = await loadPreviewData(
    admin,
    ctx.salon.id,
    ctx.salon.timezone,
    staffId,
  );
  if ("error" in preview) return fail(preview.error);
  return { ok: true, preview };
}

function parseCompletedResult(
  rpcResult: Record<string, unknown>,
  expectedAssignments?: number,
): StaffOffboardingResult {
  const reassigned = Number(rpcResult.reassigned_count);
  const notificationEventsQueued = Number(rpcResult.notification_events_queued);
  const notificationDeliveriesQueued = Number(
    rpcResult.notification_deliveries_queued,
  );
  const auditEvents = Number(rpcResult.audit_events_recorded);
  const idempotent = rpcResult.idempotent;
  if (
    !Number.isSafeInteger(reassigned) ||
    reassigned < 0 ||
    (expectedAssignments !== undefined && reassigned !== expectedAssignments) ||
    !Number.isSafeInteger(notificationEventsQueued) ||
    notificationEventsQueued < 0 ||
    !Number.isSafeInteger(notificationDeliveriesQueued) ||
    notificationDeliveriesQueued < 0 ||
    !Number.isSafeInteger(auditEvents) ||
    auditEvents !== reassigned ||
    typeof idempotent !== "boolean"
  ) {
    return fail("server_error");
  }
  return {
    ok: true,
    reassigned,
    notificationEventsQueued,
    notificationDeliveriesQueued,
  };
}

export async function completeStaffOffboarding(
  slug: string,
  input: {
    requestId: string;
    staffId: string;
    assignments: Array<{ bookingId: string; staffId: string }>;
    notifySms: boolean;
    notifyEmail: boolean;
    revokeAccess: boolean;
  },
): Promise<StaffOffboardingResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) return fail("unauthorized");
  if (!UUID_RE.test(input.requestId) || !UUID_RE.test(input.staffId) ||
      !Array.isArray(input.assignments) ||
      input.assignments.some((row) =>
        !UUID_RE.test(row.bookingId) || !UUID_RE.test(row.staffId)
      ) || new Set(input.assignments.map((row) => row.bookingId)).size !==
        input.assignments.length) return fail("invalid_input");

  let admin: SupabaseClient;
  try {
    admin = createServiceRoleClient();
  } catch {
    return fail("server_error");
  }

  const dbActorRole = ctx.kind === "demo_cookie" ? "demo_cookie" : ctx.role;
  const { data: rawResult, error: offboardingError } = await admin.rpc(
    "offboard_staff_with_durable_notifications" as never,
    {
      p_salon_id: ctx.salon.id,
      p_staff_id: input.staffId,
      p_request_id: input.requestId,
      p_actor_user_id: ctx.userId,
      p_actor_role: dbActorRole,
      p_assignments: input.assignments.map((row) => ({
        booking_id: row.bookingId,
        staff_id: row.staffId,
      })),
      p_notify_email: input.notifyEmail,
      p_notify_sms: input.notifySms,
      p_revoke_access: input.revokeAccess,
      p_notification_delay_seconds: 20,
    } as never,
  );
  if (offboardingError || !rawResult || typeof rawResult !== "object" ||
      Array.isArray(rawResult)) {
    console.error("[completeStaffOffboarding] atomic RPC", offboardingError);
    return fail("server_error");
  }
  const rpcResult = rawResult as Record<string, unknown>;
  if (rpcResult.success !== true) {
    const code = typeof rpcResult.code === "string" ? rpcResult.code : "server_error";
    const safeCodes = new Set([
      "already_inactive",
      "assign_every_booking",
      "candidate_unavailable",
      "idempotency_mismatch",
      "minimum_active_staff",
      "notification_channel_unavailable",
      "not_found",
      "operational_booking_blocked",
      "owner_access_protected",
      "sequence_receipt_invalid",
      "stale_staff",
      "stale_booking",
      "too_many_bookings",
    ]);
    return fail(safeCodes.has(code) ? code : "server_error");
  }
  const parsed = parseCompletedResult(rpcResult, input.assignments.length);
  if (!parsed.ok) return parsed;

  revalidatePath(`/dashboard/${slug}/setup/staff`);
  revalidatePath(`/dashboard/${slug}/center`);
  return parsed;
}
