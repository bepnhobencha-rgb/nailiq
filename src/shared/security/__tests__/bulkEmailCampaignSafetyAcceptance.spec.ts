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
const controlledDispatchMigration = readFileSync(
  join(root, "supabase/migrations/20260911190838_add_bulk_email_controlled_dispatch.sql"),
  "utf8",
);
const expiredLeaseMigration = readFileSync(
  join(root, "supabase/migrations/20260911191812_recover_bulk_email_expired_leases.sql"),
  "utf8",
);
const ownerReportMigration = readFileSync(
  join(root, "supabase/migrations/20260911213924_add_bulk_email_owner_reporting.sql"),
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

  it("enforces canary, pause and explicit owner bulk release in the database", () => {
    expect(controlledDispatchMigration).toContain("dispatch_stage text NOT NULL DEFAULT 'locked'");
    expect(controlledDispatchMigration).toContain("canary_claimed_count");
    expect(controlledDispatchMigration).toContain("v_campaign.canary_size::integer");
    expect(controlledDispatchMigration).toContain("v_limit := least(v_limit, v_campaign.batch_size::integer)");
    expect(controlledDispatchMigration).toContain("dispatch_cohort");
    expect(controlledDispatchMigration).toContain("member.role IN ('owner', 'admin')");
    expect(controlledDispatchMigration).toContain("canary_needs_review");
    expect(controlledDispatchMigration).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("keeps controlled dispatch RPCs service-role only", () => {
    for (const functionName of [
      "start_marketing_email_campaign_canary",
      "pause_marketing_email_campaign_dispatch",
      "resume_marketing_email_campaign_dispatch",
      "approve_marketing_email_campaign_bulk_release",
    ]) {
      expect(controlledDispatchMigration).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${functionName}[\\s\\S]*?FROM PUBLIC, anon, authenticated`),
      );
      expect(controlledDispatchMigration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${functionName}[\\s\\S]*?TO service_role`),
      );
    }
  });

  it("recovers expired leases without widening canary or blind third retries", () => {
    expect(expiredLeaseMigration).toContain("recipient.lease_expires_at <= v_now");
    expect(expiredLeaseMigration).toContain("recipient.attempt_count < 3 THEN 'prepared' ELSE 'unknown'");
    expect(expiredLeaseMigration).toContain("'provider_call_state', 'unknown'");
    expect(expiredLeaseMigration).toContain("recipient.dispatch_cohort IN ('pending', v_campaign.dispatch_stage)");
    expect(expiredLeaseMigration).toContain("v_new_claimed");
    expect(expiredLeaseMigration).toMatch(
      /REVOKE ALL ON FUNCTION public\.claim_marketing_email_campaign_recipients[\s\S]*?FROM PUBLIC, anon, authenticated/,
    );
  });

  it("makes owner reporting aggregate-only and repairs cross-campaign suppressions", () => {
    expect(ownerReportMigration).toContain("get_marketing_email_campaign_report");
    expect(ownerReportMigration).toContain("member.role IN ('owner', 'admin')");
    expect(ownerReportMigration).toContain("customer_email_delivery_suppressions");
    expect(ownerReportMigration).toContain("ON CONFLICT (salon_id, recipient_fingerprint) DO UPDATE");
    expect(ownerReportMigration).toMatch(
      /REVOKE ALL ON FUNCTION public\.get_marketing_email_campaign_report\(uuid, uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated/,
    );
    expect(ownerReportMigration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_marketing_email_campaign_report\(uuid, uuid\)[\s\S]*?TO service_role/,
    );
    const reportBody = ownerReportMigration
      .split("CREATE OR REPLACE FUNCTION public.get_marketing_email_campaign_report")[1] ?? "";
    expect(reportBody).not.toMatch(/destination_email|client_name|client_profile_id/);
  });
});
