import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const migration = read(
  "supabase/migrations/20260831042615_add_registered_email_delivery_truth.sql",
);
const route = read("src/app/api/webhooks/resend/route.ts");
const parser = read("src/shared/notifications/resendOwnerDeliveryWebhook.ts");
const registry = read("src/shared/lib/emailExperienceRegistry.ts");
const parity = read("scripts/check-schema-parity.ts");
const workflow = read(".github/workflows/migration-history-rehearsal.yml");
const rehearsal = read(
  "scripts/security/rehearse-registered-email-delivery-truth.sql",
);

describe("registered email delivery truth boundary", () => {
  it("stores replay-safe PII-free evidence without weakening specific ledgers", () => {
    expect(migration).toContain("CREATE TABLE public.registered_email_delivery_events");
    expect(migration).toContain("provider_event_id text NOT NULL UNIQUE");
    expect(migration).toContain("ON CONFLICT (provider_event_id) DO NOTHING");
    expect(migration).toContain("event_replay");
    expect(migration).toContain("event_conflict");
    expect(migration).toContain("recipient_fingerprint");
    expect(migration).not.toMatch(/\brecipient_email\b|\bsubject\b|\bhtml\b|\btext_body\b/i);
    expect(registry).toContain('deliveryTruth: "customer_booking"');
    expect(registry).toContain('deliveryTruth: "owner_booking"');
    expect(registry).toContain('deliveryTruth: "booking_otp"');
  });

  it("distinguishes provider acceptance from delivery and terminal failures", () => {
    for (const status of [
      "provider_accepted", "delivered", "delivery_delayed", "failed",
      "suppressed", "bounced", "complained",
    ]) expect(migration).toContain(`'${status}'`);
    expect(migration).toContain("registered_email_delivery_status_check");
  });

  it("keeps storage private and exposes only bounded service-role RPCs", () => {
    expect(migration).toContain(
      "ALTER TABLE public.registered_email_delivery_events ENABLE ROW LEVEL SECURITY",
    );
    expect(migration).toContain(
      "ALTER TABLE public.registered_email_delivery_events FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.registered_email_delivery_events[\s\S]{0,120}service_role/,
    );
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.record_resend_registered_email_delivery_event",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.load_registered_email_delivery_truth",
    );
  });

  it("accepts only signed events with a known purpose and matching audience", () => {
    expect(route.indexOf("const event = verifyResendWebhook")).toBeLessThan(
      route.indexOf("db = createServiceRoleClient"),
    );
    expect(parser).toContain("isEmailExperienceKey(emailKey)");
    expect(parser).toContain("emailExperienceDefinition(emailKey).audience !== audience");
    expect(route).toContain("record_resend_registered_email_delivery_event");
    expect(route).not.toContain("event.data.to");
    expect(route).not.toContain("event.data.subject");
  });

  it("wires schema parity and an executable replay/privacy rehearsal", () => {
    for (const object of [
      "registered_email_delivery_events",
      "record_resend_registered_email_delivery_event",
      "load_registered_email_delivery_truth",
    ]) expect(parity).toContain(`"${object}"`);
    expect(workflow).toContain("rehearse-registered-email-delivery-truth.sql");
    for (const contract of [
      "event_applied", "event_replay", "event_conflict",
      "direct table access reopened", "raw recipient material appeared",
    ]) expect(rehearsal).toContain(contract);
  });
});
