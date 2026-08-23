import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/shared/dashboard/staffOffboardingActions.ts"),
  "utf8",
);
const setupActions = readFileSync(
  join(process.cwd(), "src/shared/dashboard/setupActions.ts"),
  "utf8",
);
const staffDrawer = readFileSync(
  join(process.cwd(), "src/components/dashboard/StaffDrawer.tsx"),
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
]
  .map((name) =>
    readFileSync(join(process.cwd(), "supabase/migrations", name), "utf8"),
  )
  .join("\n");
const complete = source.slice(source.indexOf("export async function completeStaffOffboarding"));

describe("staff offboarding safety boundary", () => {
  it("authorizes every entry point as owner/admin", () => {
    expect(source.match(/getDashboardWriteClient\(slug\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source.match(/isOwnerOrAdmin\(ctx\.role\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("scopes staff and appointment writes to the resolved salon", () => {
    expect(complete).toContain("offboard_staff_with_durable_notifications");
    expect(complete).toContain("p_salon_id: ctx.salon.id");
    expect(complete).toContain("p_staff_id: input.staffId");
  });

  it("blocks waiting/in-service visits and requires every future booking assignment", () => {
    expect(source).toContain('const BLOCKING = ["in_progress", "waiting"]');
    expect(migration).toContain("'code','operational_booking_blocked'");
    expect(migration).toContain("'code','assign_every_booking'");
  });

  it("excludes soft-deleted parents from every preview booking query", () => {
    const preview = source.slice(
      source.indexOf("async function loadPreviewData"),
      source.indexOf("export async function loadStaffOffboardingPreview"),
    );
    expect(preview.match(/\.from\("bookings"\)/g)).toHaveLength(3);
    expect(preview.match(/\.is\("deleted_at", null\)/g)).toHaveLength(4);
  });

  it("only reassigns pending/confirmed visits and preserves their time, price, and service", () => {
    expect(source).toContain('const REASSIGNABLE = ["pending", "confirmed"]');
    expect(complete).toContain("p_assignments: input.assignments.map");
    expect(complete).not.toContain('.from("bookings")');
    expect(complete).not.toContain("price_cents");
    expect(complete).not.toContain("start_time_utc");
    expect(complete).not.toContain("service_id");
    expect(migration).toContain("booking_service_segments seg SET");
    expect(migration).toContain("nailiq.sequence_reschedule_booking_id");
    expect(migration).toContain("public_booking_pricing_snapshot=v_new_snapshot");
  });

  it("deactivates the profile without deleting staff or detaching completed history", () => {
    expect(complete).toContain("offboard_staff_with_durable_notifications");
    expect(complete).not.toMatch(/\.from\("staff"\)[\s\S]{0,120}\.delete\(\)/);
    expect(complete).not.toMatch(/\.from\("bookings"\)[\s\S]{0,120}\.delete\(\)/);
  });

  it("routes setup status/delete paths to atomic offboarding and scans both models", () => {
    const updateStaff = setupActions.slice(
      setupActions.indexOf("export async function updateStaff("),
      setupActions.indexOf("export async function deleteStaff("),
    );
    const deleteStaff = setupActions.slice(
      setupActions.indexOf("export async function deleteStaff("),
      setupActions.indexOf("export async function updateOpeningHours("),
    );
    expect(setupActions).toContain('from("booking_service_segments")');
    expect(setupActions).toContain('from("bookings")');
    expect(updateStaff).toContain('fail("staff_offboarding_required")');
    expect(deleteStaff).toContain('fail("staff_offboarding_required")');
    expect(deleteStaff).not.toContain("deleted_at: new Date()");
    expect(staffDrawer).toContain("openAtomicOffboarding");
    expect(staffDrawer).toContain('staff?.status === "active"');
    expect(staffDrawer).toContain('res.error === "staff_offboarding_required"');
  });

  it("does not cancel appointments and records an attributed audit event", () => {
    expect(source).not.toContain('status: "cancelled"');
    expect(source).not.toContain("logBookingEvent");
    expect(migration).toContain("ensure_staff_offboarding_booking_events");
    expect(migration).toContain("staff_offboarding_request_id");
    expect(migration).toContain("'reason','staff_offboarding'");
  });

  it("never calls a provider from the offboarding request", () => {
    expect(complete).not.toContain("deliverStaffActionNotification");
    expect(complete).not.toContain("sendSmsReminder");
    expect(complete).not.toContain("emails.send");
    expect(source).toContain("notificationEventsQueued");
    expect(source).toContain("notificationDeliveriesQueued");
  });
});
