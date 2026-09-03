import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const pipeline = fs.readFileSync(
  path.join(root, "src/shared/turniq/shadowTruthPipeline.ts"),
  "utf8",
);
const repository = fs.readFileSync(
  path.join(root, "src/shared/turniq/shadowTruthRepository.ts"),
  "utf8",
);
const centerPage = fs.readFileSync(
  path.join(root, "src/app/dashboard/[slug]/center/page.tsx"),
  "utf8",
);
const shadowMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260901224527_add_turniq_shadow_replay.sql"),
  "utf8",
);

describe("TurnIQ shadow truth privilege boundary", () => {
  it("runs only for an explicitly enabled shadow-stage receptionist view", () => {
    expect(pipeline).toContain('input.rolloutStage !== "shadow"');
    expect(centerPage).toContain('turnIqRolloutStage === "shadow"');
    expect(centerPage).toContain('ctx.role !== "nail_tech"');
    expect(centerPage).toContain("after(async () =>");
  });

  it("persists only immutable shadow evidence and never calls assignment/provider paths", () => {
    expect(repository).toContain('.from("turniq_shadow_decisions" as never)');
    expect(repository).toContain('.from("turniq_shadow_comparisons" as never)');
    expect(repository).not.toContain(".rpc(");
    expect(repository).not.toMatch(/bookings[^\n]*\.(insert|update|upsert|delete)/);
    expect(`${pipeline}\n${repository}`).not.toMatch(
      /Square|Stripe|Twilio|Resend|sendSms|sendEmail|apply_turniq_assignment_command/,
    );
  });

  it("keeps the shadow ledger server-only and browser-inaccessible", () => {
    expect(repository).toContain('import "server-only"');
    expect(shadowMigration).toMatch(
      /REVOKE ALL ON TABLE[\s\S]*?turniq_shadow_decisions[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(shadowMigration).toMatch(
      /GRANT SELECT, INSERT ON TABLE[\s\S]*?turniq_shadow_decisions[\s\S]*?TO service_role;/,
    );
    expect(shadowMigration).toContain(
      "CREATE TRIGGER reject_turniq_shadow_decision_mutation",
    );
  });
});
