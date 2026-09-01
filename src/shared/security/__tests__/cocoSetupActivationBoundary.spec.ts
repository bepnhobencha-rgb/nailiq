import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260901070308_protect_coco_setup_activation_state.sql",
  ),
  "utf8",
);
const invokerMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260901072612_secure_coco_setup_decision_invoker.sql",
  ),
  "utf8",
);
const registrationAction = readFileSync(
  resolve(
    process.cwd(),
    "src/shared/register/completeSalonRegistrationAction.ts",
  ),
  "utf8",
);
const registrationSuccess = readFileSync(
  resolve(process.cwd(), "src/app/register/success/page.tsx"),
  "utf8",
);
const decisionAction = readFileSync(
  resolve(
    process.cwd(),
    "src/shared/dashboard/saveCocoSetupDecisionAction.ts",
  ),
  "utf8",
);

describe("Coco Setup activation database boundary", () => {
  it("activates only the new-owner insert and resumes directly in Coco Setup", () => {
    expect(registrationAction).toContain(
      "feature_flags: withCocoSetupActivation(null)",
    );
    expect(registrationAction).toContain(
      "Only newly created owner salons enter Coco Setup automatically",
    );
    expect(registrationSuccess).toContain(
      "`/dashboard/${encodeURIComponent(slug)}/setup`",
    );
  });

  it("protects only the versioned activation receipt and preserves the legacy QA guard", () => {
    expect(migration).toContain("coco_setup_activation_version");
    expect(migration).toContain(
      "create or replace function public.protect_guided_admin_setup_rollout_flag()",
    );
    expect(migration).toContain(
      "new.feature_flags -> 'guided_admin_setup_enabled'",
    );
    expect(migration).toContain(
      "guided admin setup may be enabled only for the configured disposable Salon QA",
    );
    expect(migration).not.toContain(
      "create trigger protect_coco_setup_activation_state_trigger",
    );
  });

  it("allows activation only from service or trusted migration context", () => {
    expect(migration).toContain("v_role = 'service_role'");
    expect(migration).toContain(
      "session_user in ('postgres', 'supabase_admin')",
    );
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toMatch(
      /revoke all on function public\.protect_guided_admin_setup_rollout_flag\(\)[\s\S]*from public, anon, authenticated/i,
    );
  });

  it("makes the registration receipt one-way", () => {
    expect(migration).toContain("if tg_op = 'UPDATE' then");
    expect(migration).toContain(
      "coco setup activation cannot be changed after registration",
    );
  });

  it("records only bounded safe decisions with a tenant membership check", () => {
    expect(migration).toContain("save_coco_setup_decision");
    expect(migration).toContain("security invoker");
    expect(migration).toContain("v_request_role <> 'service_role'");
    expect(migration).toContain("sm.salon_id = p_salon_id");
    expect(migration).toContain("sm.user_id = p_actor_user_id");
    expect(migration).toContain("sm.role in ('owner', 'admin')");
    expect(migration).toContain("p_decision not in ('configured_off', 'not_using')");
    expect(migration).toMatch(
      /grant execute on function public\.save_coco_setup_decision\(uuid, uuid, text, text\)[\s\S]*to service_role/i,
    );
    expect(migration).not.toMatch(
      /grant execute on function public\.save_coco_setup_decision[\s\S]*to authenticated/i,
    );
    expect(decisionAction).toContain("isOwnerOrAdmin(ctx.role)");
    expect(decisionAction).toContain("!ctx.userId");
    expect(decisionAction).toContain("isCocoSetupExperienceVisible(ctx.salon)");
    expect(decisionAction).toContain("createServiceRoleClient().rpc(");
    expect(decisionAction).toContain('"save_coco_setup_decision" as never');
    expect(decisionAction).toContain("p_actor_user_id: ctx.userId");
    expect(invokerMigration).toContain(
      "drop function if exists public.save_coco_setup_decision(uuid, text, text)",
    );
    expect(invokerMigration).toContain("security invoker");
    expect(invokerMigration).toMatch(
      /grant execute on function public\.save_coco_setup_decision\(uuid, uuid, text, text\)[\s\S]*to service_role/i,
    );
  });
});
