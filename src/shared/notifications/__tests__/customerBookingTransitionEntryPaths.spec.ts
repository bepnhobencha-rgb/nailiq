import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("customer transition email entry paths", () => {
  it("uses atomic transition wrappers for public cancel and reschedule", () => {
    const cancel = source("src/app/api/booking/cancel-action/route.ts");
    const reschedule = source("src/app/api/booking/reschedule-action/route.ts");
    const capabilities = source("src/shared/booking/bookingManagementCapabilities.ts");
    expect(cancel).toContain("cancelBookingWithManagementCapability");
    expect(capabilities).toContain('"cancel_booking_with_management_capability"');
    expect(cancel).not.toContain('deliverStaffActionNotification');
    expect(cancel).toContain("deliverCustomerBookingTransitionEmail");
    expect(reschedule).toContain("rescheduleBookingWithManagementCapability");
    expect(capabilities).toContain('"reschedule_booking_with_management_capability"');
    expect(reschedule).toContain("deliverCustomerBookingTransitionEmail");
  });

  it("records staff channel choices atomically for cancel and reschedule", () => {
    const cancel = source("src/shared/dashboard/receptionistActions.ts");
    const edit = source("src/shared/dashboard/editBookingCore.ts");
    for (const value of [cancel, edit]) {
      expect(value).toContain("staff_action_notification_request_id");
      expect(value).toContain("staff_action_notification_channels");
      expect(value).toContain("staff_action_notification_delay_seconds");
      expect(value).toContain("createServiceRoleClient()");
      expect(value).not.toContain("deliverStaffActionNotification");
    }
  });

  it("records Voice cancel and reschedule email intent in the same guarded updates", () => {
    const voice = source("src/shared/voiceai/toolExecutor.ts");
    const capabilityMigration = source(
      "supabase/migrations/20260820140000_add_action_scoped_booking_management_capabilities.sql",
    );
    expect(voice).toContain("cancelBookingWithManagementCapability");
    expect(capabilityMigration).toContain("IF p_expected_action='cancel' THEN");
    expect(capabilityMigration).toContain(
      "status='cancelled',customer_transition_email_requested=true",
    );
    expect(voice).toContain("customer_transition_email_requested: true");
    expect(voice).toContain("customer_transition_email_not_before: new Date().toISOString()");
  });

  it("runs initial discovery, bounded retry, and stale reconciliation from the existing cron", () => {
    const cron = source("src/app/api/cron/send-pending-notifications/route.ts");
    const sender = source("src/shared/notifications/customerBookingTransitionEmail.ts");
    expect(cron).toContain("runCustomerBookingTransitionEmailWorker");
    expect(sender).toContain("discover_due_customer_booking_transition_emails");
    expect(sender).toContain("lease_due_customer_booking_transition_email_retries");
    expect(sender).toContain("reconcile_stale_customer_booking_transition_email_claims");
  });
});
