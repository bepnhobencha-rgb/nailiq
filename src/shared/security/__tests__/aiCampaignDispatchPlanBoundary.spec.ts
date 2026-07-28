import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260728104312_add_campaign_dispatch_plan.sql",
  ),
  "utf8",
);
const service = readFileSync(
  resolve(root, "src/shared/ai/campaignDispatchPlan.ts"),
  "utf8",
);
const action = readFileSync(
  resolve(root, "src/shared/ai/sealCampaignPlanAction.ts"),
  "utf8",
);

describe("AI campaign dispatch plan boundary", () => {
  it("authorizes only owner/admin dashboard writes", () => {
    expect(action).toContain("getDashboardWriteClient");
    expect(action).toContain("isOwnerOrAdmin(ctx.role)");
    expect(action).toContain('error: "forbidden"');
  });

  it("keeps recipient decisions and plans service-role-only and immutable", () => {
    expect(migration).toContain(
      "alter table public.ai_campaign_dispatch_preflight_decisions",
    );
    expect(migration).toContain(
      "alter table public.ai_campaign_dispatch_plans enable row level security",
    );
    expect(migration).toContain(
      "from public, anon, authenticated",
    );
    expect(migration).toContain(
      "create trigger ai_campaign_dispatch_preflight_decisions_immutable",
    );
    expect(migration).toContain(
      "create trigger ai_campaign_dispatch_plans_immutable",
    );
    expect(migration).toContain("security invoker");
  });

  it("requires a fresh ready preflight and exact decision counts", () => {
    expect(migration).toContain("preflight_row.status = 'ready'");
    expect(migration).toContain("preflight_row.valid_until > v_now");
    expect(migration).toContain("'fresh_preflight_required'");
    expect(migration).toContain("'decision_evidence_mismatch'");
    expect(migration).toContain("v_recipient_count > 500");
    expect(migration).toContain("v_estimated_cost > 500");
  });

  it("is idempotent, audited, PII-free, and cannot send", () => {
    expect(migration).toContain("where plan_row.preflight_id = v_preflight.id");
    expect(migration).toContain("'unchanged'::text");
    expect(migration).toContain("'campaign_dispatch_plan_sealed'");
    expect(migration).toContain("'dispatch_enabled', false");
    expect(migration).toContain("'no_messages_sent', true");
    expect(migration).not.toMatch(/phone|email_address|twilio|resend/i);
    expect(service).not.toMatch(/twilio|resend/i);
    expect(service).toContain('"seal_ai_campaign_dispatch_plan" as never');
  });
});
