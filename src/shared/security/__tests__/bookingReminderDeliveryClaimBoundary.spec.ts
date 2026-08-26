import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/20260823003401_add_atomic_booking_reminder_delivery_claims.sql",
);
const receiptMigration = read(
  "supabase/migrations/20260823124500_record_twilio_status_receipts_atomically.sql",
);
const correlationSerializationMigration = read(
  "supabase/migrations/20260823133000_serialize_twilio_correlation_completions.sql",
);

describe("MQA-0180 atomic booking reminder delivery boundary", () => {
  it("keeps claims occurrence-scoped, leased, bounded and private", () => {
    expect(migration).toContain(
      "unique (booking_id, appointment_start_utc, reminder_type, channel)",
    );
    expect(migration).toContain("attempt_count between 1 and 3");
    expect(migration).toContain("interval '15 minutes'");
    expect(migration).toContain("stale_sending_outcome_unknown");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
  });

  it("claims before every email, AI and SMS provider boundary", () => {
    const route = read("src/app/api/cron/reminders/route.ts");
    const groupClaim = route.indexOf(
      'claimReminderChannel(booking, reminderType, "email")',
    );
    const groupSend = route.indexOf("sendGroupReminderEmail", groupClaim);
    const memberClaim = route.indexOf("const memberClaim = await claimReminderChannel");
    const memberSend = route.indexOf("sendReminderEmail", memberClaim);
    const emailClaim = route.indexOf("const emailClaim = await claimReminderChannel");
    const emailSend = route.indexOf("sendReminderEmail", emailClaim);
    const smsClaim = route.indexOf("const smsClaim = await claimReminderChannel");
    const aiDraft = route.indexOf("draftReminderLead", smsClaim);
    const smsSend = route.indexOf("sendSmsReminder", smsClaim);

    for (const [claim, boundary] of [
      [groupClaim, groupSend],
      [memberClaim, memberSend],
      [emailClaim, emailSend],
      [smsClaim, aiDraft],
      [smsClaim, smsSend],
    ]) {
      expect(claim).toBeGreaterThan(-1);
      expect(boundary).toBeGreaterThan(claim);
    }
  });

  it("fails closed and never treats a missing provider receipt as sent", () => {
    const claims = read("src/shared/reminders/reminderDeliveryClaims.ts");
    expect(claims).toContain('error: "claim_unavailable"');
    expect(claims).toContain('status: "unknown"');
    expect(claims).toContain('errorCode: "provider_receipt_missing"');
    expect(claims).toContain('result.suppressed === true');
  });

  it("keeps explicit opt-out suppression and schema parity tripwires", () => {
    const email = read("src/shared/noshow/sendReminderEmail.ts");
    const parity = read("scripts/check-schema-parity.ts");
    expect(email).toContain('suppressionReason: "email_opt_out"');
    expect(parity).toContain('"booking_reminder_delivery_claims"');
    expect(parity).toContain('"claim_booking_reminder_delivery"');
    expect(parity).toContain('"complete_booking_reminder_delivery"');
  });

  it("materializes accepted SMS correlation before callback receipt handling", () => {
    const route = read("src/app/api/cron/reminders/route.ts");
    expect(receiptMigration).toContain("booking_reminder_delivery_claims_sms_sid_unique");
    expect(receiptMigration).toContain("insert into public.booking_notifications");
    expect(receiptMigration).toContain("record_twilio_message_status_receipt");
    expect(receiptMigration).toContain("receipt_identity_conflict");
    expect(receiptMigration).toContain("security definer");
    expect(receiptMigration).toContain(
      "public.staff_action_notification_caller_is_service_role()",
    );
    expect(route).not.toContain("messageSid: result.messageSid");
  });

  it("drains generic and staff callback races with one SID-first lock order", () => {
    expect(receiptMigration).toContain(
      "apply_pending_twilio_receipt_after_correlation",
    );
    expect(receiptMigration).toContain("staff_action_delivery_id");
    expect(receiptMigration).toContain(
      "staff_action_notification_deliveries_sms_sid_unique",
    );
    expect(receiptMigration).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(receiptMigration).not.toContain("pg_catalog.pg_try_advisory_xact_lock");

    for (const internal of [
      "complete_booking_confirmation_delivery_unserialized",
      "complete_staff_action_notification_delivery_unserialized",
    ]) {
      const wrapperStart = correlationSerializationMigration.indexOf(
        `create function public.${internal.replace("_unserialized", "")}(`,
      );
      const wrapper = correlationSerializationMigration.slice(wrapperStart);
      expect(wrapperStart).toBeGreaterThan(-1);
      expect(wrapper.indexOf("pg_catalog.pg_advisory_xact_lock")).toBeGreaterThan(-1);
      expect(wrapper.indexOf("pg_catalog.pg_advisory_xact_lock")).toBeLessThan(
        wrapper.indexOf(`public.${internal}(`),
      );
    }
  });
});
