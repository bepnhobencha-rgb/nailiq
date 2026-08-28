import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260828042657_add_resend_owner_delivery_truth.sql",
), "utf8");
const route = readFileSync(resolve(
  process.cwd(),
  "src/app/api/webhooks/resend/route.ts",
), "utf8");
const webhook = readFileSync(resolve(
  process.cwd(),
  "src/shared/notifications/resendOwnerDeliveryWebhook.ts",
), "utf8");
const ownerSender = readFileSync(resolve(
  process.cwd(),
  "src/shared/dashboard/sendOwnerBookingNotification.ts",
), "utf8");
const parity = readFileSync(resolve(
  process.cwd(),
  "scripts/check-schema-parity.ts",
), "utf8");
const workflow = readFileSync(resolve(
  process.cwd(),
  ".github/workflows/migration-history-rehearsal.yml",
), "utf8");
const rehearsal = readFileSync(resolve(
  process.cwd(),
  "scripts/security/rehearse-resend-owner-delivery-truth.sql",
), "utf8");

describe("Resend owner delivery truth boundary", () => {
  it("separates provider acceptance from final delivery states", () => {
    expect(migration).toContain("ADD COLUMN delivery_status");
    for (const status of [
      "provider_accepted", "delivery_delayed", "delivered",
      "failed", "suppressed", "bounced", "complained",
    ]) expect(migration).toContain(`'${status}'`);
    expect(migration).toContain("provider_accepted_at");
    expect(migration).toContain("delivered_at");
    expect(migration).toContain("delivery_failed_at");
  });

  it("persists a PII-free, replay-safe event projection and closes the receipt race", () => {
    expect(migration).toContain("CREATE TABLE public.resend_owner_delivery_events");
    expect(migration).toContain("provider_event_id text NOT NULL UNIQUE");
    expect(migration).toContain("ON CONFLICT (provider_event_id) DO NOTHING");
    expect(migration).toContain("event_conflict");
    expect(migration).toContain("recipient_fingerprint");
    expect(migration).not.toMatch(/resend_owner_delivery_events[\s\S]{0,1800}\brecipient_email\b/i);
    expect(migration).toContain("AFTER INSERT OR UPDATE OF provider_message_id");
    expect(migration).toContain("event_pending_match");
    expect(ownerSender).toContain('{ name: "nailiq_flow", value: "owner_booking" }');
    expect(ownerSender).toContain('{ name: "nailiq_claim", value: claimId }');
    expect(webhook).toContain('tags?.nailiq_flow !== "owner_booking"');
    expect(webhook).toContain("claimId: claimId.toLowerCase()");
    expect(migration).toContain("WHERE c.id = p_claim_id");
    expect(migration).toContain("signed delivery evidence can recover");
  });

  it("keeps tables private and exposes only the bounded service-role recorder", () => {
    for (const table of [
      "resend_owner_delivery_events", "owner_email_delivery_suppressions",
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toMatch(new RegExp(
        `REVOKE ALL PRIVILEGES ON TABLE public\\.${table}[\\s\\S]{0,100}service_role`,
      ));
    }
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.record_resend_owner_delivery_event",
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,100}ON\s+TABLE\s+public\.(?:resend_owner_delivery_events|owner_email_delivery_suppressions)/i,
    );
  });

  it("suppresses future provider sends after permanent delivery failures", () => {
    expect(migration).toContain("CREATE TABLE public.owner_email_delivery_suppressions");
    expect(migration).toContain("ON CONFLICT (salon_id, recipient_fingerprint) DO UPDATE");
    expect(migration).toContain("'provider_suppressed'");
    expect(migration).toMatch(
      /owner_email_delivery_suppressions[\s\S]{0,700}RETURN jsonb_build_object\([\s\S]{0,160}'provider_suppressed'/,
    );
  });

  it("verifies and bounds the raw webhook before database access", () => {
    expect(route.indexOf("const event = verifyResendWebhook")).toBeLessThan(
      route.indexOf("db = createServiceRoleClient"),
    );
    expect(route).toContain("readResendWebhookBody");
    expect(route).toContain("resendWebhookPayloadFingerprint");
    expect(route).not.toContain("event.data.to");
    expect(route).not.toContain("event.data.subject");
  });

  it("wires schema parity and executable replay/race/suppression rehearsal gates", () => {
    for (const object of [
      "resend_owner_delivery_events",
      "owner_email_delivery_suppressions",
      "record_resend_owner_delivery_event",
      "reconcile_resend_owner_delivery_events",
      "reconcile_resend_owner_delivery_on_claim",
    ]) expect(parity).toContain(`"${object}"`);
    expect(workflow).toContain("rehearse-resend-owner-delivery-truth.sql");
    for (const contract of [
      "before the send-completion",
      "event_replay",
      "event_conflict",
      "email.delivery_delayed",
      "email.complained",
      "provider_suppressed",
      "recipient mismatch",
      "delivery truth tables became directly reachable",
    ]) expect(rehearsal).toContain(contract);
  });
});
