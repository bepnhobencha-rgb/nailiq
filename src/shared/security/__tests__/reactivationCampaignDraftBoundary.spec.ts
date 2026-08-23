import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/20260822234334_add_atomic_reactivation_campaign_drafts.sql",
);

describe("MQA-0181 reactivation campaign draft boundary", () => {
  it("creates one PII-free salon/kind/week draft and keeps RPCs private", () => {
    expect(migration).toContain("unique (salon_id, campaign_kind, period_key)");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
    const claimTable = migration.slice(
      migration.indexOf("create table public.reactivation_campaign_draft_claims"),
      migration.indexOf("create or replace function public.create_reactivation_campaign_draft"),
    );
    expect(claimTable).not.toMatch(/client_phone|client_email|recipient/iu);
  });

  it("removes every provider and outbound path from both runners", () => {
    for (const path of [
      "src/shared/winback/agentWinback.ts",
      "src/shared/winback/agentRebook.ts",
    ]) {
      const source = read(path);
      expect(source).toContain("createReactivationCampaignDraft");
      expect(source).not.toMatch(
        /Anthropic|trackAnthropicMessage|sendSmsReminder|getResendClient|sendOwnerAlert|emails\.send|undo_deadline/,
      );
    }
  });

  it("requires editable EN/VI copy, separate audience and second release", () => {
    expect(migration).toContain("'message_en', v_en");
    expect(migration).toContain("'message_vi', v_vi");
    expect(migration).toContain("'recipient_selection_required', true");
    expect(migration).toContain("record_reactivation_campaign_manifest");
    expect(migration).toContain("'release_approval_required'");
    expect(migration).toContain("'dispatch_enabled', false");
    expect(migration).toContain("'no_messages_sent', true");
  });

  it("supports consent-aware winback and rebook manifests without destination PII", () => {
    const preparation = read("src/shared/ai/audiencePreparation.ts");
    expect(preparation).toContain("decideAudienceEligibility");
    expect(preparation).toContain("marketing_email_consent_at");
    expect(preparation).toContain("consent_marketing_sms");
    expect(preparation).toContain("consent_marketing_email");
    expect(preparation).toContain("recentlyContacted");
    expect(migration).toContain("marketing_rebook_audience_candidates");
    expect(migration).toContain("ai_campaign_manifest_recipients");
    expect(migration).toContain("client_profile_id");
  });
});
