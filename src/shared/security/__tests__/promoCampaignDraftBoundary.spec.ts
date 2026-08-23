import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("MQA-0179 promo campaign draft boundary", () => {
  it("claims a PII-free salon/source/week before the provider call", () => {
    const migration = read(
      "supabase/migrations/20260822230102_add_atomic_promo_campaign_drafts.sql",
    );
    const agent = read("src/shared/ai/agentStrategist.ts");
    expect(migration).toContain("unique (salon_id, source, period_key)");
    expect(migration).toContain("on conflict (salon_id, source, period_key) do nothing");
    expect(migration).toContain("attempt_count between 1 and 3");
    expect(migration).toContain("force row level security");
    expect(agent.indexOf("claimPromoCampaignDraft(")).toBeLessThan(
      agent.lastIndexOf("await runAnalysis("),
    );
    const claimTable = migration.slice(
      migration.indexOf("create table public.promo_campaign_draft_claims"),
      migration.indexOf("create or replace function public.claim_promo_campaign_draft"),
    );
    expect(claimTable).not.toMatch(/phone|email|client_profile|message text/iu);
  });

  it("keeps every generated draft dashboard-only and dispatch hard off", () => {
    const migration = read(
      "supabase/migrations/20260822230102_add_atomic_promo_campaign_drafts.sql",
    );
    const agent = read("src/shared/ai/agentStrategist.ts");
    expect(migration).toContain("'notification_mode', 'dashboard_only_no_email'");
    expect(migration).toContain("'campaign_mode', 'dashboard_draft_only'");
    expect(migration).toContain("'dispatch_enabled', false");
    expect(migration).toContain("'promotion_mutation_enabled', false");
    expect(agent).not.toContain("sendOwnerAlert");
    expect(agent).not.toContain("ACT+UNDO");
    expect(agent).not.toMatch(/resend\.emails\.send|twilio|promotions.*insert/iu);
  });

  it("requires opt-in and explicit owner confirmation for numeric offer facts", () => {
    const agent = read("src/shared/ai/agentStrategist.ts");
    const editor = read("src/components/dashboard/PromoCampaignDraftEditor.tsx");
    const migration = read(
      "supabase/migrations/20260822230102_add_atomic_promo_campaign_drafts.sql",
    );
    expect(agent).toContain("flags.ai_promo_campaign_drafts !== true");
    expect(editor).toContain("promoCampaignHasOfferFacts(message)");
    expect(editor).toContain("offerFactsConfirmed");
    expect(editor).toContain("dispatch hiện vẫn khóa");
    expect(migration).toContain("offer_confirmation_required");
    expect(migration).toContain("owner_offer_facts_confirmed_by");
  });

  it("keeps audience preparation separate and consent-aware", () => {
    const migration = read(
      "supabase/migrations/20260822230102_add_atomic_promo_campaign_drafts.sql",
    );
    const preflight = read("src/shared/ai/campaignDispatchPreflight.ts");
    const execution = read("src/shared/ai/executionEffects.ts");
    expect(migration).toContain("'recipient_selection_required', true");
    expect(preflight).toContain("marketing_consent_at");
    expect(preflight).toContain("marketing_email_consent_at");
    expect(execution).toContain('blocker: "recipient_selection_required"');
  });
});
