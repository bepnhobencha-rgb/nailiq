import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const migration = read(
  "supabase/migrations/20260814050000_close_scheduling_integrity_p1.sql",
);

describe("scheduling integrity P1 boundary", () => {
  it("persists capability configuration and never reopens an emptied whitelist", () => {
    expect(migration).toContain("staff_capability_mode");
    expect(migration).toContain("'legacy_all', 'whitelist'");
    expect(migration).toContain("enforce_staff_capability_write");
    expect(migration).toContain("capability_transition_requires_rpc");
    expect(migration).toContain("set_staff_service_capabilities");
    expect(migration).toContain("CROSS JOIN public.services");
    expect(migration).toMatch(
      /UPDATE public\.salons[\s\S]*staff_capability_mode = 'whitelist'/,
    );
    expect(migration).toContain("s.staff_capability_mode = 'whitelist'");
    expect(migration).toContain('DROP POLICY IF EXISTS "members write staff_services"');
    expect(migration).toContain("CREATE POLICY owner_admin_write_staff_services");
    expect(migration).toContain("sm.role IN ('owner', 'admin')");
    expect(migration).toContain(
      "REVOKE ALL ON TABLE public.staff_services FROM anon, authenticated",
    );

    const setup = read("src/shared/dashboard/setupActions.ts");
    expect(setup).toContain('"set_staff_service_capabilities" as never');
    expect(setup).toContain("capabilitySaved !== true");
    expect(setup).not.toContain(
      '.update({ staff_capability_mode: "whitelist" } as never)',
    );

    const staffDrawer = read("src/components/dashboard/StaffDrawer.tsx");
    expect(staffDrawer).toContain("!isEditMode ? null : services.length === 0");
    const addStaffBoundary = setup.slice(
      setup.indexOf("export async function addStaff("),
      setup.indexOf("export type StaffStatus"),
    );
    expect(addStaffBoundary).not.toContain("serviceIds?:");

    const availability = read("src/shared/dashboard/availabilityEngine.ts");
    expect(availability).toContain('rpc("salon_has_staff_services"');
    expect(availability).toContain("capRes.error || capabilityModeRes.error");
    expect(availability).toContain('return { ok: false, error: "server_error" }');

    const deskForm = read("src/components/receptionist/DeskBookingForm.tsx");
    expect(deskForm).toContain("data.salon.staffCapabilityMode");
    expect(deskForm).toContain("filterStaffCapableForServices");
  });

  it("uses a durable request-scoped ledger for exact replay and changed-payload conflict", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.group_booking_requests");
    expect(migration).toContain("PRIMARY KEY (salon_id, request_id)");
    expect(migration).toContain("payload_sha256");
    expect(migration).toContain("idempotency_conflict");
    expect(migration).toContain("idempotent_replay");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("group_booking_request_completed");
    expect(migration).toContain("validate_group_booking_otp_session");
    expect(migration).toContain("Completed exact replays bypass abuse counters");
    expect(migration).toContain("notification_capability_sha256 bytea");
    expect(migration).toContain("notification_capability_expires_at");
    expect(migration).toContain("invalid_notification_capability");
    expect(migration).toContain("extensions.digest");
  });

  it("commits booking itemization and voucher redemption inside the group transaction", () => {
    const privateBoundary = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION public.insert_group_bookings_unlimited"),
      migration.indexOf("DROP FUNCTION IF EXISTS public.insert_group_bookings(jsonb)"),
    );
    expect(privateBoundary).toContain("INSERT INTO public.bookings");
    expect(privateBoundary).toContain("INSERT INTO public.booking_addons");
    expect(privateBoundary).toContain("INSERT INTO public.voucher_redemptions");
    expect(privateBoundary).toContain("jsonb_array_length(v_addon_ids) > 8");
    expect(privateBoundary).toContain("v_addon_ids := v_addon_ids ||");
    expect(privateBoundary).toContain("sv.salon_id = v_salon_id");
  });

  it("locks the old booking and derives the moved block authoritatively", () => {
    const reschedule = migration.slice(
      migration.indexOf("CREATE FUNCTION public.reschedule_booking_as_customer"),
    );
    expect(reschedule).toContain("FOR UPDATE");
    expect(reschedule).toContain("v_block := v_booking.end_time_utc - v_booking.start_time_utc");
    expect(reschedule).toContain("v_booking.start_time_utc");
    expect(reschedule).toContain("staff_incapable");
    expect(reschedule).toContain("outside_shift");
    expect(reschedule).toContain("staff_break");
    expect(reschedule).toContain("resource_conflict");
    expect(reschedule).toContain("slot_conflict");
    expect(reschedule).toContain("public.salon_local_timestamp");
    expect(migration).toContain("booking_waitlist_promotion_request_uidx");
    expect(reschedule).toContain("promotion_request_id = v_token.id");
  });

  it("hardens public and privileged wrappers with empty search paths and explicit ACLs", () => {
    const compact = migration.replace(/\s+/g, "");
    for (const signature of [
      "insert_group_bookings_unlimited(jsonb)",
      "insert_group_bookings(jsonb, uuid)",
      "insert_controlled_after_hours_group_bookings(jsonb, uuid)",
      "reschedule_booking_as_customer(uuid, timestamptz, timestamptz)",
      "group_booking_request_completed(uuid, uuid)",
      "validate_group_booking_otp_session(uuid, uuid, text, uuid)",
      "set_staff_service_capabilities(uuid, uuid, uuid[])",
    ]) {
      expect(compact).toContain(`public.${signature.replace(/\s+/g, "")}`);
    }
    expect(migration.match(/SET search_path TO ''/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
    expect(migration).toContain("TO service_role");
  });

  it("keeps application paths on atomic RPC results with explicit errors", () => {
    const groupSubmit = read("src/shared/booking/submitGroupBooking.ts");
    expect(groupSubmit).toContain("idempotency_conflict");
    expect(groupSubmit).toContain("if (rpcErr)");
    expect(groupSubmit).toContain('"group_booking_request_completed"');
    expect(groupSubmit).toContain('"validate_group_booking_otp_session"');
    expect(groupSubmit).toContain("idempotentReplay");
    expect(groupSubmit).toContain("p_otp_session_id: otpToConsume");
    expect(groupSubmit).toContain("notification_capability:");
    expect(groupSubmit).not.toContain("group_booking_profile_finalize_failed");
    expect(groupSubmit).not.toContain('rpc("add_booking_addons"');
    expect(groupSubmit).not.toContain('rpc("redeem_voucher"');

    const voice = read("src/shared/voiceai/toolExecutor.ts");
    expect(voice).toContain("stableVoiceGroupRequestId");
    expect(voice).toContain('from("group_booking_requests"');
    expect(voice).toContain("sameServices");
    expect(voice).toContain("anchorMatches");
    const stableKey = voice.slice(
      voice.indexOf("function stableVoiceGroupRequestId"),
      voice.indexOf("async function loadGroupCtx"),
    );
    expect(stableKey).not.toContain("sessionId");
    expect(stableKey).not.toContain("serviceAssignments");
    expect(stableKey).not.toContain("mode:");
    expect(voice).toContain("if (!idempotentReplay)");

    const groupFlow = read("src/components/booking/BookingGroupFlow.tsx");
    expect(groupFlow).toContain("idempotencyPayloadRef");
    expect(groupFlow).toContain("requestFingerprint");
    expect(groupFlow).toContain("idempotencyKeyRef.current = crypto.randomUUID()");
    expect(groupFlow).toContain("notificationCapabilityRef");
    expect(groupFlow).toContain(
      "notificationCapabilityRef.current = crypto.randomUUID()",
    );

    const e2eSeed = read("e2e/helpers/db.ts");
    expect(e2eSeed).toContain('"set_staff_service_capabilities" as never');
    const capabilitySeed = e2eSeed.slice(
      e2eSeed.indexOf("// Use the same atomic capability transition"),
      e2eSeed.indexOf("return { salonId:"),
    );
    expect(capabilitySeed).not.toContain('.from("staff_services").insert');

    const slotPreview = read("src/app/api/booking/reschedule-slots/route.ts");
    expect(slotPreview).toContain("salonDayRangeUtc");
    expect(slotPreview).toContain("public_staff_shifts");
    expect(slotPreview).toContain("public_staff_unavailability");
    expect(slotPreview).toContain("staff_capability_mode");
    expect(slotPreview).toContain("resources_enabled");
    expect(slotPreview).toContain("salonWallTimeToUtcCandidates");
    expect(slotPreview).toContain("slotOptions");
    expect(slotPreview).toContain("startUtc");
    expect(slotPreview).toContain('"in_progress"');
    expect(slotPreview).toContain('"waiting"');
    expect(slotPreview).toContain('"completed"');
    expect(slotPreview).toContain('row.status !== "completed"');
    expect(slotPreview).not.toContain('"checked_in", "in_service"');

    const rescheduleAction = read(
      "src/app/api/booking/reschedule-action/route.ts",
    );
    expect(rescheduleAction).toContain("RESCHEDULE_CONFLICT_CODES");
    expect(rescheduleAction).toContain('"slot_conflict"');
    expect(rescheduleAction).toContain('"resource_conflict"');
    expect(rescheduleAction).toContain("return 409");
    expect(rescheduleAction).toContain("salonWallTimeToUtcCandidates");
    expect(rescheduleAction).toContain("exactCandidates.some");
    expect(rescheduleAction).toContain("promotionRequestId: token");

    const editCore = read("src/shared/dashboard/editBookingCore.ts");
    expect(editCore).toContain("capabilityModeErr");
    expect(editCore).toContain("requiredServiceIds");
    expect(editCore).toContain("capErr");

    const receptionist = read(
      "src/shared/dashboard/receptionistActions.ts",
    );
    expect(receptionist).toContain(
      "[assignWalkinToSlot] capability mode",
    );
  });
});
