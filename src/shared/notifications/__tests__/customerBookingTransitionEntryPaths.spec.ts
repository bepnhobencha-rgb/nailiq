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
    expect(cancel).toContain('rpc("cancel_booking_as_customer_with_transition_email"');
    expect(cancel).not.toContain('deliverStaffActionNotification');
    expect(cancel).toContain("deliverCustomerBookingTransitionEmail");
    expect(reschedule).toContain('rpc("reschedule_booking_as_customer_with_transition_email"');
    expect(reschedule).toContain("deliverCustomerBookingTransitionEmail");
  });

  it("records staff email choice atomically and leaves legacy queue SMS-only", () => {
    const cancel = source("src/shared/dashboard/receptionistActions.ts");
    const edit = source("src/shared/dashboard/editBookingCore.ts");
    for (const value of [cancel, edit]) {
      expect(value).toContain("customer_transition_email_requested");
      expect(value).toContain("customer_transition_email_not_before");
      expect(value).toContain("createServiceRoleClient()");
      expect(value).toContain("channels: { sms: true, email: false }");
    }
  });

  it("records Voice cancel and reschedule email intent in the same guarded updates", () => {
    const voice = source("src/shared/voiceai/toolExecutor.ts");
    expect(voice.match(/customer_transition_email_requested:\s*true/g)).toHaveLength(2);
    expect(voice.match(/customer_transition_email_not_before:/g)).toHaveLength(2);
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
