"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { buildCapabilityMap, isStaffCapableForService } from "@/shared/booking/staffCapability";
import { logBookingEvent, type ActorRole } from "@/shared/dashboard/auditLog";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  resolveStaffOffboardingContactPlan,
  type StaffOffboardingContactPlan,
} from "@/shared/dashboard/staffOffboardingPolicy";
import { checkBookingConflict, type ConflictCheckBooking } from "@/shared/lib/conflictCheck";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { deliverStaffActionNotification } from "@/shared/notifications/deliverStaffActionNotification";

const REASSIGNABLE = ["pending", "confirmed"] as const;
const BLOCKING = ["in_progress", "waiting"] as const;
const OPEN = [...REASSIGNABLE, ...BLOCKING] as const;

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
  customerRequestedStaff: boolean;
  originalStaffRequestNote: string | null;
  candidates: StaffOffboardingCandidate[];
};

export type StaffOffboardingPreview = {
  staffId: string;
  staffName: string;
  timezone: string;
  hasLogin: boolean;
  accessIsOwner: boolean;
  bookings: StaffOffboardingBooking[];
};

export type StaffOffboardingResult =
  | {
      ok: true;
      reassigned: number;
      notificationsSent: number;
      notificationAttempts: number;
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
  staff_requested_by_client: boolean | null;
  staff_request_note: string | null;
  start_time_utc: string | null;
  end_time_utc: string | null;
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

function actorRole(ctx: { kind: "member" | "demo_cookie"; role: string }): ActorRole {
  if (ctx.kind === "demo_cookie") return "demo_cookie";
  if (ctx.role === "admin" || ctx.role === "receptionist") return "manager";
  return ctx.role as ActorRole;
}

async function loadPreviewData(
  admin: SupabaseClient,
  salonId: string,
  timezone: string,
  staffId: string,
): Promise<StaffOffboardingPreview | { error: string }> {
  const { data: staffRows, error: staffErr } = await admin
    .from("staff")
    .select("id, name, status, user_id")
    .eq("salon_id", salonId)
    .is("deleted_at", null);
  if (staffErr) return { error: "server_error" };

  const staff = (staffRows ?? []) as RawStaff[];
  const target = staff.find((row) => row.id === staffId);
  if (!target) return { error: "not_found" };
  if (target.status === "inactive") return { error: "already_inactive" };

  const activeCandidates = staff.filter(
    (row) => row.id !== staffId && row.status === "active",
  );

  const { data: openRows, error: openErr } = await admin
    .from("bookings")
    .select(
      "id, staff_id, service_id, addon_service_id, client_name, client_phone, client_email, staff_requested_by_client, staff_request_note, start_time_utc, end_time_utc, status",
    )
    .eq("salon_id", salonId)
    .eq("staff_id", staffId)
    .in("status", [...OPEN])
    .order("start_time_utc", { ascending: true });
  if (openErr) return { error: "server_error" };
  const openBookings = (openRows ?? []) as RawBooking[];

  const serviceIds = Array.from(
    new Set(
      openBookings.flatMap((row) =>
        [row.service_id, row.addon_service_id].filter(
          (id): id is string => Boolean(id),
        ),
      ),
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

  let existingBookings: ConflictCheckBooking[] = [];
  const candidateIds = activeCandidates.map((row) => row.id);
  if (candidateIds.length > 0 && openBookings.length > 0) {
    const starts = openBookings
      .map((row) => row.start_time_utc)
      .filter((value): value is string => Boolean(value));
    const ends = openBookings
      .map((row) => row.end_time_utc)
      .filter((value): value is string => Boolean(value));
    if (starts.length > 0 && ends.length > 0) {
      const minStart = starts.reduce((a, b) => (a < b ? a : b));
      const maxEnd = ends.reduce((a, b) => (a > b ? a : b));
      const { data: conflicts, error: conflictErr } = await admin
        .from("bookings")
        .select("id, staff_id, start_time_utc, end_time_utc, status, client_name")
        .eq("salon_id", salonId)
        .in("staff_id", candidateIds)
        .lt("start_time_utc", maxEnd)
        .gt("end_time_utc", minStart)
        .neq("status", "cancelled");
      if (conflictErr) return { error: "server_error" };
      existingBookings = (conflicts ?? []) as ConflictCheckBooking[];
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
    const requiredServices = [booking.service_id, booking.addon_service_id].filter(
      (id): id is string => Boolean(id),
    );
    const candidates =
      booking.status === "pending" || booking.status === "confirmed"
        ? activeCandidates
            .filter((candidate) =>
              requiredServices.every((serviceId) =>
                isStaffCapableForService(capability, candidate.id, serviceId),
              ),
            )
            .filter((candidate) => {
              if (!booking.start_time_utc || !booking.end_time_utc) return false;
              return !checkBookingConflict({
                staffId: candidate.id,
                startUtcIso: booking.start_time_utc,
                endUtcIso: booking.end_time_utc,
                existingBookings,
                excludeBookingId: booking.id,
              });
            })
            .map(({ id, name }) => ({ id, name }))
        : [];

    return {
      id: booking.id,
      clientName: booking.client_name?.trim() || "Guest",
      serviceName:
        (booking.service_id && serviceNameById.get(booking.service_id)) ||
        "Service",
      startTimeUtc: booking.start_time_utc || "",
      endTimeUtc: booking.end_time_utc || "",
      status: booking.status as OpenStatus,
      hasPhone: Boolean(booking.client_phone?.trim()),
      hasEmail: Boolean(booking.client_email?.trim()),
      customerRequestedStaff:
        booking.staff_requested_by_client === true ||
        Boolean(booking.staff_request_note?.trim()),
      originalStaffRequestNote: booking.staff_request_note?.trim() || null,
      candidates,
    };
  });

  return {
    staffId,
    staffName: target.name,
    timezone,
    hasLogin: Boolean(target.user_id),
    accessIsOwner,
    bookings,
  };
}

export async function loadStaffOffboardingPreview(
  slug: string,
  staffId: string,
): Promise<{ ok: true; preview: StaffOffboardingPreview } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) return fail("unauthorized");
  let admin: SupabaseClient;
  try {
    admin = createServiceRoleClient();
  } catch {
    return fail("server_error");
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

export async function completeStaffOffboarding(
  slug: string,
  input: {
    staffId: string;
    assignments: Array<{ bookingId: string; staffId: string }>;
    notifySms: boolean;
    notifyEmail: boolean;
    manualContactConfirmed: boolean;
    revokeAccess: boolean;
  },
): Promise<StaffOffboardingResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) return fail("unauthorized");
  if (!input.staffId || !Array.isArray(input.assignments)) return fail("invalid_input");
  const salonId = ctx.salon.id;

  let admin: SupabaseClient;
  try {
    admin = createServiceRoleClient();
  } catch {
    return fail("server_error");
  }

  const preview = await loadPreviewData(
    admin,
    ctx.salon.id,
    ctx.salon.timezone,
    input.staffId,
  );
  if ("error" in preview) return fail(preview.error);
  if (preview.accessIsOwner) return fail("owner_access_protected");

  const blockers = preview.bookings.filter((booking) =>
    (BLOCKING as readonly string[]).includes(booking.status),
  );
  if (blockers.length > 0) return fail("operational_booking_blocked");

  const reassignable = preview.bookings.filter((booking) =>
    (REASSIGNABLE as readonly string[]).includes(booking.status),
  );
  const assignmentMap = new Map(
    input.assignments.map((row) => [row.bookingId, row.staffId]),
  );
  if (assignmentMap.size !== reassignable.length) return fail("assign_every_booking");

  for (const booking of reassignable) {
    const nextStaffId = assignmentMap.get(booking.id);
    if (!nextStaffId) return fail("assign_every_booking");
    if (!booking.candidates.some((candidate) => candidate.id === nextStaffId)) {
      return fail("candidate_unavailable");
    }
  }

  const requestedWithoutContactPlan = reassignable.filter(
    (booking) =>
      resolveStaffOffboardingContactPlan({
        customerRequestedStaff: booking.customerRequestedStaff,
        hasEmail: booking.hasEmail,
        hasPhone: booking.hasPhone,
        notifyEmail: input.notifyEmail,
        notifySms: input.notifySms,
        manualContactConfirmed: input.manualContactConfirmed,
      }) === null,
  );
  if (requestedWithoutContactPlan.length > 0) {
    return fail("requested_staff_contact_required");
  }

  const { count: otherActiveCount, error: activeCountErr } = await admin
    .from("staff")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", ctx.salon.id)
    .eq("status", "active")
    .neq("id", input.staffId)
    .is("deleted_at", null);
  if (activeCountErr) return fail("server_error");
  if ((otherActiveCount ?? 0) < 1) return fail("minimum_active_staff");

  const completed: Array<{
    bookingId: string;
    nextStaffId: string;
    customerRequestedPreviousStaff: boolean;
    originalStaffRequestNote: string | null;
    customerContactPlan: StaffOffboardingContactPlan;
  }> = [];
  async function rollbackAssignments() {
    for (const done of completed.slice().reverse()) {
      await admin
        .from("bookings")
        .update({
          staff_id: input.staffId,
          staff_requested_by_client: done.customerRequestedPreviousStaff,
          staff_request_note: done.originalStaffRequestNote,
        } as never)
        .eq("id", done.bookingId)
        .eq("salon_id", salonId)
        .eq("staff_id", done.nextStaffId);
    }
  }

  type RevokedAccessSnapshot = {
    userId: string;
    membershipRole: string | null;
    membershipCreatedAt: string | null;
    membershipRemoved: boolean;
    staffUnlinked: boolean;
  };
  let revokedAccess: RevokedAccessSnapshot | null = null;

  async function restoreRevokedAccess(): Promise<boolean> {
    if (!revokedAccess) return true;
    let restored = true;

    if (revokedAccess.membershipRemoved && revokedAccess.membershipRole) {
      const { error } = await admin.from("salon_members").upsert(
        {
          salon_id: salonId,
          user_id: revokedAccess.userId,
          role: revokedAccess.membershipRole,
          created_at: revokedAccess.membershipCreatedAt,
        },
        { onConflict: "salon_id,user_id" },
      );
      if (error) {
        restored = false;
        console.error("[completeStaffOffboarding] restore membership", error);
      }
    }

    if (revokedAccess.staffUnlinked) {
      const { error } = await admin
        .from("staff")
        .update({ user_id: revokedAccess.userId })
        .eq("id", input.staffId)
        .eq("salon_id", salonId)
        .is("deleted_at", null);
      if (error) {
        restored = false;
        console.error("[completeStaffOffboarding] restore staff login", error);
      }
    }

    return restored;
  }

  for (const booking of reassignable) {
    const nextStaffId = assignmentMap.get(booking.id)!;
    const customerContactPlan = resolveStaffOffboardingContactPlan({
      customerRequestedStaff: booking.customerRequestedStaff,
      hasEmail: booking.hasEmail,
      hasPhone: booking.hasPhone,
      notifyEmail: input.notifyEmail,
      notifySms: input.notifySms,
      manualContactConfirmed: input.manualContactConfirmed,
    });
    if (!customerContactPlan) {
      await rollbackAssignments();
      return fail("requested_staff_contact_required");
    }
    const { data: changed, error } = await admin
      .from("bookings")
      .update({
        staff_id: nextStaffId,
        ...(booking.customerRequestedStaff
          ? {
              staff_requested_by_client: false,
              staff_request_note: null,
            }
          : {}),
      } as never)
      .eq("id", booking.id)
      .eq("salon_id", ctx.salon.id)
      .eq("staff_id", input.staffId)
      .in("status", [...REASSIGNABLE])
      .select("id")
      .maybeSingle();
    if (error || !changed?.id) {
      await rollbackAssignments();
      return fail(error?.code === "23P01" ? "candidate_unavailable" : "stale_booking");
    }
    completed.push({
      bookingId: booking.id,
      nextStaffId,
      customerRequestedPreviousStaff: booking.customerRequestedStaff,
      originalStaffRequestNote: booking.originalStaffRequestNote,
      customerContactPlan,
    });
  }

  if (input.revokeAccess && preview.hasLogin) {
    const { data: target, error: targetErr } = await admin
      .from("staff")
      .select("user_id")
      .eq("id", input.staffId)
      .eq("salon_id", ctx.salon.id)
      .maybeSingle();
    if (targetErr || !target) {
      await rollbackAssignments();
      return fail("access_revoke_failed");
    }
    const userId = (target as { user_id?: string | null } | null)?.user_id;
    if (userId) {
      const { data: membership, error: membershipErr } = await admin
        .from("salon_members")
        .select("role, created_at")
        .eq("salon_id", salonId)
        .eq("user_id", userId)
        .maybeSingle();
      if (membershipErr) {
        await rollbackAssignments();
        return fail("access_revoke_failed");
      }
      const membershipRow = membership as {
        role?: string | null;
        created_at?: string | null;
      } | null;
      if (membershipRow?.role === "owner") {
        await rollbackAssignments();
        return fail("owner_access_protected");
      }

      revokedAccess = {
        userId,
        membershipRole: membershipRow?.role ?? null,
        membershipCreatedAt: membershipRow?.created_at ?? null,
        membershipRemoved: false,
        staffUnlinked: false,
      };

      if (membershipRow) {
        const { data: removedMembership, error: accessErr } = await admin
          .from("salon_members")
          .delete()
          .eq("salon_id", salonId)
          .eq("user_id", userId)
          .neq("role", "owner")
          .select("id")
          .maybeSingle();
        if (accessErr || !removedMembership?.id) {
          await rollbackAssignments();
          return fail("access_revoke_failed");
        }
        revokedAccess.membershipRemoved = true;
      }

      const { data: unlinkedStaff, error: unlinkErr } = await admin
        .from("staff")
        .update({ user_id: null })
        .eq("id", input.staffId)
        .eq("salon_id", ctx.salon.id)
        .eq("user_id", userId)
        .select("id")
        .maybeSingle();
      if (unlinkErr || !unlinkedStaff?.id) {
        await restoreRevokedAccess();
        await rollbackAssignments();
        return fail("access_revoke_failed");
      }
      revokedAccess.staffUnlinked = true;
    }
  }

  // A replacement is not automatically the customer's new favorite. Clear
  // both the explicit global preference and this salon's inferred usual staff
  // so future rebook suggestions never offer an inactive provider.
  const { data: clearedProfiles, error: profilePreferenceErr } = await admin
    .from("client_profiles")
    .update({ preferred_staff_id: null })
    .eq("preferred_staff_id", input.staffId)
    .select("id");
  if (profilePreferenceErr) {
    await restoreRevokedAccess();
    await rollbackAssignments();
    return fail("preference_cleanup_failed");
  }

  const { data: clearedPatterns, error: patternPreferenceErr } = await admin
    .from("customer_booking_patterns")
    .update({ usual_staff_id: null })
    .eq("salon_id", ctx.salon.id)
    .eq("usual_staff_id", input.staffId)
    .select("id");
  if (patternPreferenceErr) {
    const profileIds = (clearedProfiles ?? []).map((row) => row.id);
    if (profileIds.length > 0) {
      await admin
        .from("client_profiles")
        .update({ preferred_staff_id: input.staffId })
        .in("id", profileIds);
    }
    await restoreRevokedAccess();
    await rollbackAssignments();
    return fail("preference_cleanup_failed");
  }

  async function restorePreferences() {
    const profileIds = (clearedProfiles ?? []).map((row) => row.id);
    const patternIds = (clearedPatterns ?? []).map((row) => row.id);
    if (profileIds.length > 0) {
      await admin
        .from("client_profiles")
        .update({ preferred_staff_id: input.staffId })
        .in("id", profileIds);
    }
    if (patternIds.length > 0) {
      await admin
        .from("customer_booking_patterns")
        .update({ usual_staff_id: input.staffId })
        .eq("salon_id", salonId)
        .in("id", patternIds);
    }
  }

  const { data: deactivatedStaff, error: deactivateErr } = await admin
    .from("staff")
    .update({ status: "inactive" })
    .eq("id", input.staffId)
    .eq("salon_id", ctx.salon.id)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (deactivateErr || !deactivatedStaff?.id) {
    await restorePreferences();
    await restoreRevokedAccess();
    await rollbackAssignments();
    return fail("deactivate_failed");
  }

  for (const done of completed) {
    await logBookingEvent({
      bookingId: done.bookingId,
      salonId: ctx.salon.id,
      actorUserId: ctx.userId,
      actorRole: actorRole(ctx),
      eventType: "booking_edited",
      payload: {
        reason: "staff_offboarding",
        previous_staff_id: input.staffId,
        new_staff_id: done.nextStaffId,
        customer_requested_previous_staff:
          done.customerRequestedPreviousStaff,
        customer_contact_plan: done.customerContactPlan,
      },
    });
  }

  let notificationAttempts = 0;
  let notificationsSent = 0;
  if (input.notifySms || input.notifyEmail) {
    for (const done of completed) {
      notificationAttempts += 1;
      const result = await deliverStaffActionNotification(admin, {
        salonId: ctx.salon.id,
        bookingId: done.bookingId,
        event: "staff_change",
        channels: { sms: input.notifySms, email: input.notifyEmail },
        previousStaffName: preview.staffName,
        customerRequestedPreviousStaff:
          done.customerRequestedPreviousStaff,
      });
      notificationsSent += Number(result.smsSent) + Number(result.emailSent);
    }
  }

  revalidatePath(`/dashboard/${slug}/setup/staff`);
  revalidatePath(`/dashboard/${slug}/center`);
  return {
    ok: true,
    reassigned: completed.length,
    notificationsSent,
    notificationAttempts,
  };
}
