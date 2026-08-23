import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const service = readFileSync(
  resolve(root, "src/shared/ai/audiencePreparation.ts"),
  "utf8",
);
const action = readFileSync(
  resolve(root, "src/shared/ai/prepareAudienceAction.ts"),
  "utf8",
);
const migration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260728084526_create_immutable_campaign_release_gate.sql",
  ),
  "utf8",
);
const reactivationMigration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260822234334_add_atomic_reactivation_campaign_drafts.sql",
  ),
  "utf8",
);

describe("AI audience preparation boundary", () => {
  it("requires owner/admin and binds the service call to the resolved salon", () => {
    expect(action).toContain("getDashboardWriteClient(input.slug)");
    expect(action).toContain("isOwnerOrAdmin(ctx.role)");
    expect(action).toContain("salonId: ctx.salon.id");
  });

  it("keeps the execution job waiting for separate release authorization", () => {
    expect(service).toContain('job.status !== "waiting_input"');
    expect(service).toContain('"record_ai_campaign_manifest"');
    expect(service).toContain('"record_reactivation_campaign_manifest"');
    expect(service).toContain("no_messages_sent: true");
    expect(migration).toContain("'blocker', 'release_approval_required'");
    expect(migration).toContain("and status = 'waiting_input'");
  });

  it("supports separate consent-aware winback and rebook dry-run segments", () => {
    expect(service).toContain('"marketing_audience_candidates" as never');
    expect(service).toContain('"marketing_rebook_audience_candidates" as never');
    expect(service).toContain('"winback_lapsed_regulars_45_365_days"');
    expect(service).toContain('"rebook_due_regulars"');
    expect(reactivationMigration).toContain("p_summary ->> 'segment' not in");
    expect(reactivationMigration).toContain("'language_routing_required', true");
  });

  it("persists manifest, recipients, release approval, and audit atomically", () => {
    expect(migration).toContain("for update");
    expect(migration).toContain("'unchanged'::text");
    expect(migration).toContain("insert into public.ai_campaign_manifests");
    expect(migration).toContain(
      "insert into public.ai_campaign_manifest_recipients",
    );
    expect(migration).toContain("insert into public.approval_requests");
    expect(migration).toContain("update public.ai_execution_jobs");
    expect(migration).toContain("insert into public.ai_actions_log");
    expect(migration).toContain("'campaign_manifest_prepared'");
    expect(migration).toContain(
      "revoke all on function public.record_ai_campaign_manifest",
    );
    expect(migration).toContain("to service_role");
  });

  it("recomputes and compares identity/channel fingerprint in the database", () => {
    expect(service).toContain("client_profile_id: profile.id");
    expect(migration).toContain("string_agg(");
    expect(migration).toContain("v_fingerprint <> p_summary");
    expect(migration).toContain("v_recipient_count <> v_unique_count");
  });

  it("makes both manifest tables private, RLS-protected, and immutable", () => {
    expect(migration).toContain(
      "alter table public.ai_campaign_manifests enable row level security",
    );
    expect(migration).toContain(
      "alter table public.ai_campaign_manifest_recipients enable row level security",
    );
    expect(migration).toContain(
      "revoke all on table public.ai_campaign_manifests",
    );
    expect(migration).toContain("campaign_manifest_is_immutable");
    expect(migration).toContain("before update or delete");
  });

  it("creates a final approval that remains no-send after approval", () => {
    expect(migration).toContain("'dispatch_enabled', false");
    expect(migration).toContain("'dispatch_not_enabled'");
    expect(migration).toContain("'dispatch_authorization_required', true");
    expect(migration).toContain("'no_messages_sent', true");
  });

  it("contains no outbound provider dependency", () => {
    expect(service).not.toContain("sendSmsReminder");
    expect(service).not.toContain("getResendClient");
    expect(service).not.toContain("twilio");
    expect(service).not.toContain(".emails.send");
  });
});
