import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("booking confirmation retry runtime adoption", () => {
  it("routes both initial provider entry paths through the tokenized immutable-envelope boundary", () => {
    const sms = source("src/shared/booking/claimedConfirmationSms.ts");
    const email = source("src/shared/booking/sendBookingConfirmationEmail.ts");
    const groupEmail = source("src/shared/booking/sendGroupBookingConfirmationEmail.ts");

    expect(sms).toContain("deliverBookingConfirmation");
    expect(sms).toContain('channel: "sms"');
    expect(email).toContain("deliverBookingConfirmation");
    expect(email).toContain('channel: "email"');
    expect(email).not.toContain("resend.emails.send");
    expect(groupEmail).toContain("deliverBookingConfirmation");
    expect(groupEmail).toContain('channel: "email"');
    expect(groupEmail).not.toContain("getResendClient");
  });

  it("uses the six-argument claim and exact leased envelope in the shared worker", () => {
    const runtime = source("src/shared/booking/bookingConfirmationRetryDelivery.ts");
    expect(runtime).toContain('p_dispatch_envelope: input.dispatchEnvelope');
    expect(runtime).toContain('value.dispatch_envelope');
    expect(runtime).toContain('"lease_due_booking_confirmation_retries"');
    expect(runtime).toContain('"reconcile_stale_booking_confirmation_claims"');
    expect(runtime).toContain("serialized.text !== lease.dispatchEnvelope");
    expect(runtime).toContain("serialized.payloadFingerprint !== lease.payloadFingerprint");
    expect(runtime).toContain("serialized.recipientFingerprint !== lease.recipientFingerprint");
  });

  it("wires the bounded mixed-channel retry worker into the authenticated cron", () => {
    const cron = source("src/app/api/cron/send-pending-notifications/route.ts");
    expect(cron).toContain("requireCronAuthorization(req)");
    expect(cron).toContain("runBookingConfirmationRetryWorker(BOOKING_CONFIRMATION_RETRY_BATCH)");
    expect(cron).toContain("BOOKING_CONFIRMATION_RETRY_BATCH = 10");
    expect(cron).toContain("bookingConfirmationRetries");
    expect(cron.indexOf("await runBookingConfirmationRetryWorker")).toBeLessThan(
      cron.indexOf("for (const rowRaw of due ?? [])"),
    );
  });

  it("pairs runtime adoption with the later service-only immutable DB envelope contract", () => {
    const migration = source("supabase/migrations/20260821003000_add_immutable_booking_confirmation_dispatch_envelopes.sql");
    expect(migration).toContain("booking_confirmation_dispatch_envelopes");
    expect(migration).toMatch(/claim_booking_confirmation_delivery\([\s\S]*p_dispatch_envelope text/);
    expect(migration).toContain("octet_length(dispatch_envelope) BETWEEN 1 AND 262144");
    expect(migration).toContain("payload_fingerprint', v_stored.payload_fingerprint");
    expect(migration).toContain("dispatch_envelope', v_stored.dispatch_envelope");
    expect(migration).toContain("dispatch_envelope_required");
  });

  it("keeps the separate scheduled staff-action pipeline off the confirmation unique key", () => {
    const staffAction = source("src/shared/notifications/deliverStaffActionNotification.ts");
    const notificationLog = source("src/shared/lib/notificationLog.ts");
    const realtime = source("src/components/dashboard/NotificationsRealtimeWidget.tsx");
    const activity = source("src/shared/dashboard/loadActivityFeedAction.ts");
    const baseline = source("supabase/migrations/20260723000000_folded_production_schema_baseline.sql");

    expect(staffAction.match(/notificationType: "staff_action"/g)).toHaveLength(2);
    expect(staffAction).not.toContain('notificationType: "booking_confirmation"');
    expect(notificationLog).toContain('| "staff_action"');
    expect(realtime).toContain('staff_action: "Staff booking update"');
    expect(activity).toContain('staff_action: "Cập nhật lịch hẹn từ salon"');
    expect(baseline).toMatch(/booking_notifications_confirmation_once[\s\S]*notification_type = 'booking_confirmation'/);
  });
});
