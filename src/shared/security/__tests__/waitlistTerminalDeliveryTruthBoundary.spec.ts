import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReleaseSchemaContract } from "./releaseSchemaContract";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const migration = read(
  "supabase/migrations/20260914150934_waitlist_offer_terminal_delivery_truth.sql",
);
const loader = read("src/shared/noshow/loadWaitlistDeliveryTruth.ts");
const parity = read("scripts/check-schema-parity.ts");
const rehearsal = read("scripts/security/rehearse-waitlist-claim-capabilities.sql");

describe("Waitlist terminal delivery truth boundary", () => {
  it("combines provider acceptance with terminal Twilio and Resend evidence", () => {
    expect(migration).toContain("public.waitlist_offer_delivery_outbox");
    expect(migration).toContain("public.sms_delivery_attempts");
    expect(migration).toContain("public.registered_email_delivery_events");
    for (const status of [
      "accepted",
      "delivered",
      "failed",
      "suppressed",
      "unknown",
    ]) {
      expect(migration).toContain(`'${status}'`);
    }
    expect(migration).toContain("event.delivery_status");
    expect(migration).toContain(
      "sms_attempt.recipient_fingerprint = outbox.recipient_fingerprint",
    );
    expect(migration).toContain(
      "event.recipient_fingerprint = outbox.recipient_fingerprint",
    );
    expect(migration).toContain("event.recipient_count = 1");
    expect(migration).toContain("ORDER BY");
  });

  it("is tenant-scoped, cardinality-bounded and service-role-only", () => {
    expect(migration).toContain("outbox.salon_id = p_salon_id");
    expect(migration).toContain("cardinality(p_waitlist_entry_ids) BETWEEN 1 AND 100");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path TO ''");
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.load_waitlist_offer_delivery_truth[\s\S]{0,160}FROM PUBLIC, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.load_waitlist_offer_delivery_truth[\s\S]{0,160}TO service_role/i,
    );
  });

  it("returns no recipient, fingerprint, provider receipt or message id", () => {
    const returned = migration.slice(
      migration.indexOf("RETURNS TABLE"),
      migration.indexOf("LANGUAGE sql"),
    );
    expect(returned).not.toMatch(
      /recipient|fingerprint|provider_receipt|provider_message|phone|email_address/i,
    );
  });

  it("wires the server loader and full schema parity tripwire", () => {
    expect(loader).toContain('"load_waitlist_offer_delivery_truth"');
    expect(loader).not.toContain('from("waitlist_offer_delivery_outbox"');
    expect(parity).toContain('"load_waitlist_offer_delivery_truth"');
    assertReleaseSchemaContract(parity);
    for (const contract of [
      "terminal Twilio failure was still projected as provider accepted",
      "terminal Resend delivery was not projected",
      "late accepted callback downgraded terminal Resend failure",
      "waitlist delivery truth crossed salon boundary",
      "oversized waitlist delivery truth request was accepted",
      "waitlist delivery truth RPC became browser-callable",
    ]) {
      expect(rehearsal).toContain(contract);
    }
  });
});
