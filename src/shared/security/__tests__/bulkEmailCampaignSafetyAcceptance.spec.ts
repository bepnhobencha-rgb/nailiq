import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(
  join(root, "supabase/migrations/20260911153229_add_bulk_email_campaign_delivery_foundation.sql"),
  "utf8",
);
const fkIndexesMigration = readFileSync(
  join(root, "supabase/migrations/20260911164500_add_bulk_email_campaign_fk_indexes.sql"),
  "utf8",
);
const delivery = readFileSync(join(root, "src/shared/marketing/bulkEmailCampaignDelivery.ts"), "utf8");
const registry = readFileSync(join(root, "src/shared/lib/emailExperienceRegistry.ts"), "utf8");
const webhook = readFileSync(join(root, "src/app/api/webhooks/resend/route.ts"), "utf8");

describe("bulk email campaign safety acceptance", () => {
  it("keeps recipient storage PII-free and browser access denied", () => {
    const recipientsTable = migration.split("CREATE TABLE public.marketing_email_campaign_recipients")[1]?.split("CREATE TABLE public.marketing_email_campaign_events")[0] ?? "";
    expect(recipientsTable).not.toMatch(/\bemail\s+text\b/i);
    expect(recipientsTable).not.toMatch(/\bphone\s+text\b/i);
    expect(migration).toContain("marketing_email_campaign_recipients ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("marketing_email_campaign_recipients FORCE ROW LEVEL SECURITY");
    expect(migration).toMatch(/REVOKE ALL PRIVILEGES ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
  });

  it("requires service role, owner or admin, consent, opt-out and suppression checks", () => {
    expect(migration).toContain("marketing_email_campaign_caller_is_service_role()");
    expect(migration).toContain("member.role IN ('owner', 'admin')");
    expect(migration).toContain("consent_marketing_email IS TRUE");
    expect(migration).toContain("client_email_optouts");
    expect(migration).toContain("customer_email_delivery_suppressions");
    expect(migration).toContain("load_marketing_email_campaign_delivery_material");
  });

  it("requires lease, idempotency and two independent dispatch gates", () => {
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("UNIQUE (idempotency_key)");
    expect(migration).toContain("bulk_email_campaign_dispatch_enabled");
    expect(delivery).toContain('BULK_EMAIL_CAMPAIGN_DISPATCH_ENABLED !== "true"');
    expect(delivery).toContain("idempotencyKey: claim.idempotency_key");
  });

  it("registers signed delivery truth and makes lifecycle events immutable", () => {
    expect(registry).toContain("bulk_marketing_campaign");
    expect(registry).toContain("src/shared/marketing/bulkEmailCampaignDelivery.ts");
    expect(migration).toContain("marketing_email_campaign_events_immutable");
    expect(migration).toContain("append-only");
    expect(migration).toContain("record_marketing_email_campaign_delivery_event");
    expect(webhook).toContain('registeredMaterial.emailKey === "bulk_marketing_campaign"');
  });

  it("covers every campaign-ledger foreign key reported by the database advisor", () => {
    expect(fkIndexesMigration).toContain("marketing_email_campaigns_created_by_idx");
    expect(fkIndexesMigration).toContain("marketing_email_campaigns_approved_by_idx");
    expect(fkIndexesMigration).toContain("marketing_email_campaign_recipients_client_profile_idx");
    expect(fkIndexesMigration).toContain("marketing_email_campaign_events_salon_idx");
    expect(fkIndexesMigration).toContain("marketing_email_campaign_events_actor_idx");
    expect(fkIndexesMigration).not.toMatch(/GRANT|feature_flags|email_outbound_enabled/i);
  });
});
