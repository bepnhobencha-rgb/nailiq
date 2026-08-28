import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/20260828070918_add_customer_email_delivery_truth.sql");
const webhook = read("src/shared/notifications/resendOwnerDeliveryWebhook.ts");
const route = read("src/app/api/webhooks/resend/route.ts");
const confirmation = read("src/shared/booking/bookingConfirmationRetryDelivery.ts");
const reminders = read("src/shared/noshow/sendReminderEmail.ts");
const transitions = read("src/shared/notifications/customerBookingTransitionEmail.ts");
const cron = read("src/app/api/cron/reminders/route.ts");
const parity = read("scripts/check-schema-parity.ts");
const workflow = read(".github/workflows/migration-history-rehearsal.yml");
const rehearsal = read("scripts/security/rehearse-resend-customer-delivery-truth.sql");

describe("Resend customer delivery truth boundary", () => {
  it("covers confirmation, reminder and transition claims with one signed ledger", () => {
    expect(migration).toContain("CREATE TABLE public.resend_customer_delivery_events");
    for (const kind of ["confirmation", "reminder", "transition"]) {
      expect(migration).toContain(`'${kind}'`);
      expect(webhook).toContain(`\"${kind}\"`);
    }
    expect(route).toContain("record_resend_customer_delivery_event");
    expect(migration).toContain("provider_event_id text NOT NULL UNIQUE");
    expect(migration).toContain("event_conflict");
    expect(migration).not.toMatch(/resend_customer_delivery_events[\s\S]{0,1800}\brecipient_email\b/i);
  });

  it("tags every provider send with its durable customer claim", () => {
    for (const source of [confirmation, reminders, transitions]) {
      expect(source).toContain('{ name: "nailiq_flow", value: "customer_booking" }');
      expect(source).toContain('{ name: "nailiq_claim_kind"');
      expect(source).toContain('{ name: "nailiq_claim"');
    }
  });

  it("separates provider acceptance from delivery and projects truthful dashboard states", () => {
    for (const status of [
      "provider_accepted", "delivery_delayed", "delivered", "failed",
      "suppressed", "bounced", "complained",
    ]) expect(migration).toContain(`'${status}'`);
    expect(migration).toContain("email_delivery_status");
    expect(migration).toContain("email_provider_accepted_at");
    expect(migration).toContain("email_delivered_at");
    expect(migration).toContain("email_delivery_failed_at");
    expect(migration).toContain("INSERT INTO public.booking_notifications");
    expect(migration).toContain("WHEN v_current_status = 'delivered' THEN 'delivered'");
  });

  it("suppresses permanent provider failures before any later provider call", () => {
    expect(migration).toContain("CREATE TABLE public.customer_email_delivery_suppressions");
    expect(migration).toContain("customer_email_delivery_suppression_reason");
    expect(confirmation.indexOf("emailSuppressionReason")).toBeLessThan(
      confirmation.indexOf("deps.sendEmail"),
    );
    const groupClaim = cron.indexOf(
      'const claim = await claimReminderChannel(booking, reminderType, "email")',
    );
    expect(cron.indexOf("suppressReminderEmailBeforeProvider", groupClaim)).toBeLessThan(
      cron.indexOf("sendGroupReminderEmail", groupClaim),
    );
    expect(transitions.indexOf("emailSuppressionReason")).toBeLessThan(
      transitions.indexOf("provider.send"),
    );
    for (const source of [confirmation, transitions]) {
      expect(source).toContain('"suppression_lookup_unavailable"');
      expect(source).toContain('"retryable_pre_acceptance"');
    }
    expect(cron).toContain('status: lookupUnavailable ? "failed" : "suppressed"');
    expect(cron).toContain('errorCode: "capability_mint_unavailable"');
    const retryableMember = cron.indexOf("let retryableMemberFailure");
    expect(retryableMember).toBeGreaterThan(-1);
    expect(cron.indexOf(
      "await markGroupReminderSent(booking.group_id, reminderType)",
      retryableMember,
    )).toBeGreaterThan(retryableMember);
  });

  it("keeps the ledger private and wires executable schema gates", () => {
    for (const table of [
      "resend_customer_delivery_events", "customer_email_delivery_suppressions",
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
      expect(parity).toContain(`\"${table}\"`);
    }
    for (const fn of [
      "record_resend_customer_delivery_event",
      "reconcile_resend_customer_delivery_events",
      "customer_email_delivery_suppression_reason",
    ]) expect(parity).toContain(`\"${fn}\"`);
    expect(workflow).toContain("rehearse-resend-customer-delivery-truth.sql");
    for (const contract of [
      "confirmation delivery truth failed",
      "reminder delivery truth/projection failed",
      "transition complaint/suppression/projection failed",
      "exact replay was not idempotent",
      "customer delivery truth tables became directly reachable",
    ]) expect(rehearsal).toContain(contract);
  });
});
