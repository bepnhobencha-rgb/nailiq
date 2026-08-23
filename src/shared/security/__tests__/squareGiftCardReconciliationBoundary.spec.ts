import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(join(
  root,
  "supabase/migrations/20260822172547_add_square_gift_card_reconciliation.sql",
), "utf8");
const issuanceHardening = readFileSync(join(
  root,
  "supabase/migrations/20260822195023_harden_square_gift_card_issuance_material.sql",
), "utf8");
const issuanceWorker = readFileSync(join(
  root,
  "src/shared/integrations/square/giftCardIssuanceWorker.ts",
), "utf8");
const webhook = readFileSync(
  join(root, "src/shared/integrations/square/webhookRuntime.ts"),
  "utf8",
);
const optional = readFileSync(
  join(root, "src/shared/integrations/square/optionalCapabilities.ts"),
  "utf8",
);
const giftCardConfig = readFileSync(
  join(root, "src/shared/loyalty/giftCardConfig.ts"),
  "utf8",
);
const giftCardPage = readFileSync(
  join(root, "src/app/[slug]/gift/page.tsx"),
  "utf8",
);
const concurrency = readFileSync(
  join(root, "scripts/security/rehearse-square-gift-card-concurrency.mjs"),
  "utf8",
);

describe("MQA-0125 Square Gift Card reconciliation boundary", () => {
  it("keeps every value-changing path hard off and provider-call-free", () => {
    expect(optional).toContain('SQUARE_OPTIONAL_API_VERSION = "2026-07-15"');
    expect(optional).toMatch(/gift_cards:\s*false/);
    expect(giftCardConfig).toContain("GIFT_CARD_PURCHASE_ENABLED = false");
    expect(giftCardConfig).toContain("GIFT_CARD_VALUE_MUTATIONS_ENABLED = false");
    expect(migration).toMatch(/does\s+-- not call Square, enable Gift Cards, create a NailIQ voucher/);
  });

  it("marks the hard-off Gift Card route noindex before any salon lookup", () => {
    const metadata = giftCardPage.slice(
      giftCardPage.indexOf("export async function generateMetadata"),
      giftCardPage.indexOf("export default async function GiftCardPage"),
    );
    const hardOff = metadata.indexOf("if (!GIFT_CARD_PURCHASE_ENABLED)");
    expect(hardOff).toBeGreaterThan(-1);
    expect(metadata).toContain('title: { absolute: "Not found | NailIQ" }');
    expect(metadata).toContain("robots: { index: false, follow: false }");
    expect(metadata).toContain("alternates: { canonical: null }");
    expect(hardOff).toBeLessThan(metadata.indexOf("createClient()"));
  });

  it("binds local issuance evidence only after the complete succeeded receipt chain", () => {
    expect(migration).toContain("bind_square_gift_card_issuance");
    expect(migration).toContain("activation_receipt_required");
    expect(migration).toContain("payment_receipt_required");
    expect(migration).toContain("create_receipt_required");
    expect(migration).toContain("receipt_chain_mismatch");
    expect(migration).toContain("o.status = 'succeeded'");
    expect(migration).toContain("o.provider_receipt_id IS NOT NULL");
    expect(migration).not.toMatch(/insert into public\.vouchers/i);
    expect(issuanceHardening).toContain("'line_item_uid'");
    expect(issuanceHardening).toContain("payment_source_fingerprint");
    expect(issuanceHardening).not.toMatch(/'payment_source_token',\s*p_request[^\n]+v_material/i);
    expect(issuanceWorker).toContain("SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE.gift_cards");
    expect(issuanceWorker).toContain("provider_outcome_ambiguous");
    expect(issuanceWorker).toContain("bind_square_gift_card_issuance");
  });

  it("stores GAN-free provider state with no invented expiration", () => {
    expect(migration).toContain("square_gift_card_mirrors");
    expect(migration).toContain("square_gift_card_activity_mirrors");
    expect(migration).not.toMatch(/\n\s*(?:gan|expires_at|expiry\w*)\s+(?:text|timestamp|timestamptz)/i);
    expect(webhook).toContain("gift_card_balance_money");
    expect(webhook).not.toMatch(/projected\.(gan|customer_ids)/);
  });

  it("preserves partial redeem/refund revisions as an immutable append-only ledger", () => {
    expect(migration).toContain("Square gift card activity mirrors are immutable");
    expect(migration).toContain("'REDEEM'");
    expect(migration).toContain("'REFUND'");
    expect(migration).toContain("square_redeem_activity_id");
    expect(migration).toContain("provider_balance_after_cents");
    expect(migration).toContain("UNIQUE (provider_account_fingerprint, webhook_event_id)");
  });

  it("atomically adopts claimed inbox revisions and survives out-of-order concurrency", () => {
    expect(migration).toContain("apply_square_gift_card_webhook_event");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("status = 'processed'");
    expect(migration).toContain("INSERT INTO public.square_sync_cursors");
    expect(concurrency).toContain("Promise.all(claims.map(apply))");
    expect(concurrency).toContain('"ACTIVE:3750:CAD"');
    expect(concurrency).toContain('"PENDING,COMPLETED"');
  });

  it("uses forced RLS and grants read-only mirror access to service_role", () => {
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("GRANT SELECT ON public.square_gift_card_mirrors");
    expect(migration).not.toMatch(/GRANT (ALL|INSERT|UPDATE|DELETE).*square_gift_card_/i);
  });
});
