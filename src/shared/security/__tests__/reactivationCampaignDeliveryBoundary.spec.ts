import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/20260823038000_add_reactivation_campaign_delivery_contract.sql",
);
const runtime = read("src/shared/ai/reactivationCampaignDelivery.ts");

describe("MQA-0181 durable reactivation delivery boundary", () => {
  it("keeps the app literally hard-off without DB, provider, route or cron adoption", () => {
    expect(runtime).toContain(
      "REACTIVATION_CAMPAIGN_DELIVERY_HARD_OFF = true as const",
    );
    expect(runtime.indexOf("if (REACTIVATION_CAMPAIGN_DELIVERY_HARD_OFF)"))
      .toBeLessThan(runtime.indexOf("The literal guard above"));
    expect(runtime).not.toMatch(
      /createServiceRoleClient|createServerClient|twilio|resend|fetch\(|\.rpc\(/i,
    );

    for (const path of [
      "src/app/api/cron/manager/route.ts",
      "src/app/api/cron/reminders/route.ts",
      "src/app/api/cron/campaign-scheduler/route.ts",
    ]) {
      expect(read(path)).not.toContain("runReactivationCampaignDelivery");
    }
  });

  it("persists no raw destination or message material and uses keyed email hashing", () => {
    const tables = migration.slice(
      migration.indexOf("CREATE TABLE public.reactivation_campaign_deliveries"),
      migration.indexOf("CREATE INDEX reactivation_campaign_deliveries_plan_idx"),
    );
    expect(tables).not.toMatch(
      /\n\s+(?:phone|email|body|message|destination)\s+(?:text|jsonb)\b/i,
    );
    expect(migration).toContain("extensions.hmac");
    expect(migration).toContain("sms_consent_hash_secret");
    expect(migration).toContain("hash_sms_consent_phone");
    expect(migration).toContain("load_sms_outbound_suppression");
    expect(migration).toContain("client_email_optouts");
  });

  it("binds exact fresh reactivation provenance and never expands a channel", () => {
    for (const fragment of [
      "public.ai_campaign_dispatch_plans",
      "public.ai_campaign_dispatch_preflights",
      "public.ai_campaign_dispatch_preflight_decisions",
      "public.ai_campaign_manifests",
      "public.ai_campaign_manifest_recipients",
      "public.ai_execution_jobs",
      "public.approval_requests",
      "public.salon_clients",
      "public.customer_preferences",
      "reactivation_campaign_release_gate",
      "reactivation_campaign",
      "ai_tenant_allows_autonomous_execution",
      "preflight.valid_until > v_now",
      "plan.expires_at > v_now",
      "decision.exclusion IS NULL",
      "decision.sms AND recipient.sms",
      "decision.email AND recipient.email",
    ]) {
      expect(migration).toContain(fragment);
    }
    for (const exactClaimTimeBinding of [
      "release_job.action_type = 'bulk_message'",
      "release_approval.action_type = 'bulk_message'",
      "source_approval.action_type = 'bulk_message'",
      "release_job.payload ->> 'manifest_id'",
      "release_job.payload ->> 'source_execution_job_id'",
      "release_job.payload ->> 'audience_fingerprint'",
      "release_job.payload ->> 'message_sha256'",
    ]) {
      expect(migration.split(exactClaimTimeBinding)).toHaveLength(3);
    }
    expect(
      migration.match(
        /FOR UPDATE OF plan_lock, preflight_lock, manifest_lock/g,
      ) ?? [],
    ).toHaveLength(2);
    expect(migration).toContain(
      "recipient_scope.client_profile_id::text || ':'",
    );
    expect(migration).toContain(
      "coalesce(decision_scope.exclusion, 'eligible')",
    );
    expect(
      migration.match(/manifest_contract\.tenant_scope_valid/g) ?? [],
    ).toHaveLength(2);
    expect(
      migration.match(/preflight_contract\.tenant_scope_valid/g) ?? [],
    ).toHaveLength(2);
    for (const summaryCount of [
      "manifest_recipient_count",
      "dual_channel_count",
      "excluded_recent_contact",
      "excluded_no_consent",
      "excluded_no_channel",
      "excluded_missing_profile",
      "excluded_manifest_channel_unavailable",
      "estimated_cost_usd_cents",
    ]) {
      expect(migration).toContain(
        `preflight.summary -> '${summaryCount}'`,
      );
    }
  });

  it("requires an immutable authorization that no exposed role can create", () => {
    expect(migration).toContain(
      "CREATE TABLE public.reactivation_campaign_dispatch_authorizations",
    );
    expect(migration).toContain(
      "ALTER TABLE public.reactivation_campaign_dispatch_authorizations FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toContain(
      "reactivation_campaign_dispatch_authorizations,\n  public.reactivation_campaign_delivery_receipts\n  FROM PUBLIC, anon, authenticated, service_role",
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)[\s\S]{0,160}reactivation_campaign_dispatch_authorizations/i,
    );
    expect(migration).not.toMatch(
      /CREATE FUNCTION public\.(?:create|insert|authorize)_reactivation_campaign_dispatch/i,
    );
    expect(migration).toContain("'code', 'dispatch_not_authorized'");
    expect(migration).toContain("'provider_ready', false");
  });

  it("uses FORCE RLS, service-role-only RPC grants, CAS leases and terminal unknown", () => {
    expect((migration.match(/FORCE ROW LEVEL SECURITY/g) ?? [])).toHaveLength(3);
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("v_now := clock_timestamp();\n    v_reason := NULL;");
    expect(
      migration.match(/v_now timestamptz := clock_timestamp\(\);/g) ?? [],
    ).toHaveLength(7);
    expect(migration).not.toContain(
      "v_now timestamptz := transaction_timestamp();",
    );
    expect(migration).toContain("attempt_count BETWEEN 0 AND 1");
    expect(migration).toContain("lease_token_hash");
    expect(migration).toContain("stale_attempt");
    expect(migration).toContain("status = 'unknown'");
    expect(migration).toContain("'retry_allowed', false");
    expect(migration).toContain("provider_accepted");
    expect(migration).toContain("receipt_kind = 'delivered'");
    expect(migration).toContain("callback_auth_fingerprint");
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain("TO service_role");
  });

  it("accepts only categorical completion codes", () => {
    expect(migration).toContain("provider_rejected_pre_acceptance");
    expect(migration).toContain("provider_outcome_unknown");
    expect(migration).toContain("p_error_code NOT IN");
    expect(migration).not.toContain("char_length(coalesce(p_error_code");
    expect(migration).toContain(
      "provider_name IN ('sms_provider', 'email_provider')",
    );
    expect(migration).not.toContain("p_provider_name !~");
  });
});
