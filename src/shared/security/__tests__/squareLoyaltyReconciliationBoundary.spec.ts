import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(join(
  root,
  "supabase/migrations/20260822165659_add_square_loyalty_reconciliation.sql",
), "utf8");
const webhook = readFileSync(
  join(root, "src/shared/integrations/square/webhookRuntime.ts"),
  "utf8",
);
const optional = readFileSync(
  join(root, "src/shared/integrations/square/optionalCapabilities.ts"),
  "utf8",
);
const concurrency = readFileSync(
  join(root, "scripts/security/rehearse-square-loyalty-concurrency.mjs"),
  "utf8",
);

describe("MQA-0124 Square Loyalty reconciliation boundary", () => {
  it("keeps the provider capability hard off while pinning the reviewed API", () => {
    expect(optional).toContain('SQUARE_OPTIONAL_API_VERSION = "2026-07-15"');
    expect(optional).toMatch(/loyalty:\s*false/);
    expect(migration).toMatch(/does\s+-- not call Square or enable the provider capability/);
  });

  it("stores only a PII-free account, event and reward mirror", () => {
    expect(migration).toContain("square_loyalty_account_mirrors");
    expect(migration).toContain("square_loyalty_event_mirrors");
    expect(migration).toContain("square_loyalty_reward_mirrors");
    expect(migration).not.toMatch(/phone_number|customer_id|client_phone/i);
    expect(webhook).toContain("accumulate_promotion_points");
    expect(webhook).toContain("points_delta");
  });

  it("requires an exact succeeded provider receipt before subject binding", () => {
    expect(migration).toContain("provider_receipt_binding_required");
    expect(migration).toContain("o.status = 'succeeded'");
    expect(migration).toContain("o.provider_receipt_id IS NOT NULL");
    expect(migration).toContain("o.material ->> 'source_id' = p_subject_fingerprint");
  });

  it("atomically adopts claimed inbox events and advances the cursor", () => {
    expect(migration).toContain("apply_square_loyalty_webhook_event");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("status = 'processed'");
    expect(migration).toContain("INSERT INTO public.square_sync_cursors");
    expect(concurrency).toContain("Promise.all(claims.map(apply))");
    expect(concurrency).toContain('"20:50:active"');
  });

  it("denies direct mirror mutation and preserves the event ledger", () => {
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("GRANT SELECT ON public.square_loyalty_account_mirrors");
    expect(migration).toContain("Square loyalty event mirrors are immutable");
    expect(migration).not.toMatch(/GRANT (ALL|INSERT|UPDATE|DELETE).*square_loyalty_/i);
  });
});
