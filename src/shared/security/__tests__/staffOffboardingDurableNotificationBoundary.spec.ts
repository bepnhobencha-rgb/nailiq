import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const hardeningMigration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260823033000_harden_staff_offboarding_sequence_contract.sql",
  ),
  "utf8",
);
const raceHardeningMigration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260823037000_close_staff_deactivation_assignment_races.sql",
  ),
  "utf8",
);
const cascadeCorrectionMigration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260823037100_allow_salon_cascade_through_staff_invariant.sql",
  ),
  "utf8",
);
const nonactiveGuardMigration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260823037200_guard_all_nonactive_staff_and_salon_moves.sql",
  ),
  "utf8",
);
const lifecycleBoundaryMigration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260823082850_require_atomic_staff_lifecycle_changes.sql",
  ),
  "utf8",
);
const migration = [
  "20260823025524_extend_staff_offboarding_durable_outbox.sql",
  "20260823033000_harden_staff_offboarding_sequence_contract.sql",
  "20260823034500_fix_staff_change_capture_btrim.sql",
  "20260823035000_fix_staff_offboarding_deferred_constraint.sql",
  "20260823037000_close_staff_deactivation_assignment_races.sql",
  "20260823037100_allow_salon_cascade_through_staff_invariant.sql",
  "20260823037200_guard_all_nonactive_staff_and_salon_moves.sql",
  "20260823082850_require_atomic_staff_lifecycle_changes.sql",
]
  .map((name) => readFileSync(resolve(root, "supabase/migrations", name), "utf8"))
  .join("\n");
const action = readFileSync(
  resolve(root, "src/shared/dashboard/staffOffboardingActions.ts"),
  "utf8",
);
const drawer = readFileSync(
  resolve(root, "src/components/dashboard/StaffOffboardingDrawer.tsx"),
  "utf8",
);
const delivery = readFileSync(
  resolve(root, "src/shared/notifications/staffActionNotificationDelivery.ts"),
  "utf8",
);
const envelope = readFileSync(
  resolve(root, "src/shared/notifications/staffActionNotificationEnvelope.ts"),
  "utf8",
);

describe("MQA-0225 durable staff-change offboarding boundary", () => {
  it("widens the existing event constraint through a validated strict superset", () => {
    expect(migration).toMatch(
      /event_type IN \('create','reschedule','cancel','staff_change'\)\) NOT VALID/,
    );
    expect(migration).toContain(
      "VALIDATE CONSTRAINT staff_action_notification_outbox_event_type_check_v2",
    );
    expect(migration.indexOf("VALIDATE CONSTRAINT")).toBeLessThan(
      migration.indexOf("DROP CONSTRAINT staff_action_notification_outbox_event_type_check;"),
    );
  });

  it("captures a pure staff change before the legacy occurrence trigger", () => {
    expect(migration).toContain(
      "CREATE TRIGGER zy_capture_staff_change_notification_occurrence",
    );
    expect(
      "zy_capture_staff_change_notification_occurrence" <
        "zz_capture_staff_action_notification_occurrence",
    ).toBe(true);
    expect(migration).toContain("NEW.staff_id IS NOT DISTINCT FROM OLD.staff_id");
    expect(migration).toContain("NEW.start_time_utc IS DISTINCT FROM OLD.start_time_utc");
    expect(migration).toContain("NEW.staff_action_notification_request_id:=NULL");
    expect(migration).toContain("event_type='staff_change'");
  });

  it("commits reassignment, access revoke, deactivation, outbox and receipt in one RPC", () => {
    const rpc = hardeningMigration.slice(
      hardeningMigration.indexOf("CREATE OR REPLACE FUNCTION public.offboard_staff_with_durable_notifications("),
      hardeningMigration.indexOf("-- Lost-response recovery"),
    );
    expect(rpc).toContain("pg_advisory_xact_lock");
    expect(rpc).toContain("ORDER BY b.id FOR UPDATE");
    expect(rpc).toContain("staff_id=v_assignment.staff_id");
    expect(rpc).toContain("staff_action_notification_request_id=v_notification_request_id");
    expect(rpc).toContain("DELETE FROM public.salon_members");
    expect(rpc).toContain("UPDATE public.staff SET status='inactive'");
    expect(rpc).toContain("INSERT INTO public.staff_offboarding_receipts");
    expect(rpc).toContain("ensure_staff_offboarding_booking_events");
    expect(rpc).toContain("atomic staff change notification capture failed");
    expect(rpc).not.toMatch(/twilio|resend|emails\.send|sendSmsReminder/i);
  });

  it("keeps receipt and RPC browser-inaccessible and service-role-only", () => {
    expect(migration).toContain(
      "ALTER TABLE public.staff_offboarding_receipts ENABLE ROW LEVEL SECURITY",
    );
    expect(migration).toContain(
      "ALTER TABLE public.staff_offboarding_receipts FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toContain(
      'CREATE POLICY "deny browser access to staff offboarding receipts"',
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.offboard_staff_with_durable_notifications\([\s\S]*?FROM PUBLIC,anon,authenticated;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.offboard_staff_with_durable_notifications\([\s\S]*?TO service_role;/,
    );
  });

  it("routes runtime offboarding to the RPC and extends both parsers", () => {
    const complete = action.slice(
      action.indexOf("export async function completeStaffOffboarding"),
    );
    expect(complete).toContain("offboard_staff_with_durable_notifications");
    expect(complete).not.toContain("loadPreviewData");
    expect(complete).not.toContain("deliverStaffActionNotification");
    expect(delivery).toContain('value === "staff_change"');
    expect(envelope).toContain('value === "staff_change"');
    expect(envelope).toContain("Appointment Provider Updated");
    expect(drawer).toContain("no provider attempt was recorded at this action boundary");
    expect(drawer).not.toContain("liên hệ khách thủ công");
  });

  it("covers sequence authority, disabled channels, recovery and canonical audit", () => {
    expect(action).toContain('.from("booking_service_segments")');
    expect(action).toContain("recover_staff_offboarding_with_durable_notifications");
    expect(action).toContain("emailOutboundEnabled");
    expect(action).toContain("smsOutboundEnabled");
    expect(action).not.toContain("logBookingEvent");
    expect(drawer).toContain("window.sessionStorage.setItem");
    expect(drawer).toContain("window.sessionStorage.removeItem");
    expect(migration).toContain("nailiq.staff_change_force_booking_id");
    expect(migration).toContain("booking_service_segments seg SET");
    expect(migration).toContain("notification_channel_unavailable");
    expect(migration).toContain("booking_events_staff_offboarding_request_booking_uidx");
    expect(migration).toContain("recover_staff_offboarding_with_durable_notifications");
  });

  it("closes direct deactivation and booking/segment assignment races", () => {
    const assignmentGuard = raceHardeningMigration.slice(
      raceHardeningMigration.indexOf(
        "CREATE OR REPLACE FUNCTION public.enforce_active_staff_for_live_booking()",
      ),
      raceHardeningMigration.indexOf(
        "CREATE OR REPLACE FUNCTION public.enforce_no_live_assignments_on_staff_deactivation()",
      ),
    );
    expect(raceHardeningMigration).toContain(
      "enforce_no_live_assignments_before_staff_deactivation",
    );
    expect(raceHardeningMigration).toContain(
      "FROM public.booking_service_segments seg",
    );
    expect(raceHardeningMigration).toContain("ORDER BY b.id");
    expect(raceHardeningMigration).toContain(
      "ORDER BY seg.booking_id,seg.position,seg.id",
    );
    expect(assignmentGuard).toContain("FOR UPDATE;");
    expect(assignmentGuard).not.toContain("FOR KEY SHARE;");
    expect(raceHardeningMigration).toContain(
      "offboard_staff_with_durable_notifications_v3_impl",
    );
    expect(cascadeCorrectionMigration).toContain(
      "TG_OP='DELETE' AND NOT EXISTS",
    );
    expect(cascadeCorrectionMigration).toContain("FROM public.salons");
    expect(nonactiveGuardMigration).toContain("NEW.status<>'active'");
    expect(nonactiveGuardMigration).toContain(
      "legacy non-active staff has live assignments",
    );
    expect(nonactiveGuardMigration).toContain(
      "LOCK TABLE public.staff IN SHARE ROW EXCLUSIVE MODE",
    );
    expect(nonactiveGuardMigration).toContain(
      "NEW.salon_id IS DISTINCT FROM OLD.salon_id",
    );
    expect(nonactiveGuardMigration).toContain("staff salon_id is immutable");
    const nonactiveGuard = nonactiveGuardMigration.slice(
      nonactiveGuardMigration.indexOf(
        "CREATE OR REPLACE FUNCTION public.enforce_no_live_assignments_on_staff_deactivation()",
      ),
    );
    expect(nonactiveGuard.indexOf("staff salon_id is immutable")).toBeLessThan(
      nonactiveGuard.indexOf("FROM public.bookings"),
    );
    expect(nonactiveGuardMigration).toContain(
      "BEFORE UPDATE OF status,deleted_at,salon_id OR DELETE",
    );
  });

  it("requires browser lifecycle writes to use atomic offboarding", () => {
    expect(lifecycleBoundaryMigration).toContain(
      'DROP POLICY IF EXISTS "managers delete staff for own salon"',
    );
    expect(lifecycleBoundaryMigration).toContain(
      "REVOKE DELETE ON TABLE public.staff FROM authenticated",
    );
    expect(lifecycleBoundaryMigration).toContain(
      "staff_action_notification_caller_is_service_role()",
    );
    expect(lifecycleBoundaryMigration).toContain(
      "staff lifecycle changes require atomic offboarding",
    );
    expect(lifecycleBoundaryMigration).toContain("OLD.status='active'");
    expect(lifecycleBoundaryMigration).toContain(
      "TG_OP='DELETE' AND NOT EXISTS",
    );
    expect(lifecycleBoundaryMigration).toContain(
      "staff with live bookings must be offboarded atomically",
    );
    expect(lifecycleBoundaryMigration).toContain(
      "DROP TRIGGER IF EXISTS enforce_no_live_assignments_before_staff_deactivation",
    );
    expect(lifecycleBoundaryMigration).toContain(
      "BEFORE UPDATE OF status,deleted_at,salon_id OR DELETE",
    );
  });
});
