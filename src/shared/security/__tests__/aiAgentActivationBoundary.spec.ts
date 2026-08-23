import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_AGENT_IMPACT } from "@/shared/dashboard/aiAgentTypes";

const actions = readFileSync(
  resolve(process.cwd(), "src/shared/dashboard/salonOwnerActions.ts"),
  "utf8",
);
const hub = readFileSync(
  resolve(process.cwd(), "src/components/dashboard/AiManagerHub.tsx"),
  "utf8",
);
const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260730021524_atomic_ai_agent_permissions.sql",
  ),
  "utf8",
);
const permissionPolicyMigrations = [
  migration,
  readFileSync(
    resolve(
      process.cwd(),
      "supabase/migrations/20260822230102_add_atomic_promo_campaign_drafts.sql",
    ),
    "utf8",
  ),
].join("\n");
const schemaParity = readFileSync(
  resolve(process.cwd(), "scripts/check-schema-parity.ts"),
  "utf8",
);
const customerOutreachSources = [
  "src/shared/ai/agentVipCare.ts",
  "src/shared/firstvisit/agentFirstVisit.ts",
  "src/app/api/cron/reminders/route.ts",
].map((path) => ({
  path,
  source: readFileSync(resolve(process.cwd(), path), "utf8"),
}));
const noShowPolicy = readFileSync(
  resolve(process.cwd(), "src/shared/noshow/agentNoShowPolicy.ts"),
  "utf8",
);

describe("AI agent activation boundary", () => {
  it("validates the runtime key before any salon write", () => {
    const validation = actions.indexOf("if (!isAiAgentFlagKey(flagKey))");
    const writeContext = actions.indexOf(
      "getDashboardWriteClient(slug)",
      validation,
    );
    expect(validation).toBeGreaterThan(-1);
    expect(writeContext).toBeGreaterThan(validation);
    expect(actions).toContain('if (typeof enabled !== "boolean")');
    expect(actions).toContain('error: "invalid_enabled_value"');
  });

  it("fails closed when impact acknowledgement is missing", () => {
    expect(actions).toContain("requiresAiAgentEnableAcknowledgement(flagKey)");
    expect(actions).toContain('error: "impact_confirmation_required"');
    expect(actions).toContain("options?.impactAcknowledged !== true");
  });

  it("moves permission writes behind one service-only atomic RPC", () => {
    expect(actions).toContain('"set_ai_agent_permission" as never');
    expect(actions).not.toContain(".update({ feature_flags: merged }");
    expect(migration).toContain("for update;");
    expect(migration).toContain("jsonb_set(");
    expect(migration).toContain(
      "insert into public.ai_agent_permission_audit",
    );
    expect(migration).toContain(
      "create trigger ai_agent_permission_audit_immutable",
    );
    expect(migration).toContain(
      "raise exception 'ai_agent_permission_audit_is_immutable'",
    );
    expect(migration).toContain(
      "revoke execute on function public.set_ai_agent_permission(",
    );
    expect(migration).toContain("from public, anon, authenticated;");
  });

  it("validates actor, impact, and acknowledgement again inside Postgres", () => {
    expect(migration).toContain("sm.user_id = p_actor_user_id");
    expect(migration).toContain("sm.role in ('owner', 'admin')");
    expect(migration).toContain(
      "p_impact is distinct from v_expected_impact",
    );
    expect(migration).toContain(
      "and p_impact_acknowledged is distinct from true",
    );
  });

  it("keeps the database impact policy aligned with the application allowlist", () => {
    for (const [flagKey, impact] of Object.entries(AI_AGENT_IMPACT)) {
      expect(permissionPolicyMigrations).toContain(
        `when '${flagKey}' then '${impact}'`,
      );
    }
  });

  it("makes the permission control plane part of blank-database parity", () => {
    expect(schemaParity).toContain('"ai_agent_permission_audit"');
    expect(schemaParity).toContain('"set_ai_agent_permission"');
    expect(schemaParity).toContain(
      '"reject_ai_agent_permission_audit_mutation"',
    );
  });

  it("presents the impact and asks before activating sensitive agents", () => {
    expect(hub).toContain("window.confirm(");
    expect(hub).toContain("data-impact={impact}");
    expect(hub).toContain("impactAcknowledged: needsAcknowledgement");
    expect(hub).not.toContain("safe to enable without risk of over-messaging");
  });

  it("re-reads customer-outreach permission inside every multi-recipient runner", () => {
    for (const { path, source } of customerOutreachSources) {
      expect(source, path).toContain("isAiAgentPermissionEnabled");
      expect(source, path).toMatch(/await isAiAgentPermissionEnabled\(/);
    }
  });

  it("re-reads live no-show permission after model work and before booking mutation", () => {
    const freshPermission = noShowPolicy.indexOf(
      'isAiAgentPermissionEnabled(\n        ctx.salonId,\n        "ai_noshow_policy_live"',
    );
    const liveDecision = noShowPolicy.indexOf(
      "const live = livePermissionStillEnabled && ai != null",
    );
    const bookingMutation = noShowPolicy.indexOf(
      ".update({ noshow_card_required: cardRequired }",
    );

    expect(freshPermission).toBeGreaterThan(-1);
    expect(liveDecision).toBeGreaterThan(freshPermission);
    expect(bookingMutation).toBeGreaterThan(liveDecision);
  });
});
