import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260826015329_add_error_remediation_release_gate.sql",
);
const actions = read("src/shared/superadmin/errorMonitorActions.ts");
const monitor = read("src/components/superadmin/ErrorMonitorClient.tsx");
const rehearsal = read(
  "scripts/security/rehearse-error-remediation-release-gate.sql",
);

describe("error remediation release gate boundary", () => {
  it("requires exact-SHA QA and a separate approval before resolution", () => {
    expect(migration).toContain("error_logs_qa_candidate_sha_check");
    expect(migration).toContain("error_logs_qa_gate_material_check");
    expect(migration).toContain("error_logs_resolution_approval_material_check");
    expect(migration).toContain("error_resolution_requires_qa_and_product_approval");
    expect(actions).toContain('.eq("remediation_state" as never, "approved")');
    expect(actions).toContain("recordErrorQaPass");
    expect(actions).toContain("approveErrorResolution");
    expect(actions).toContain('access.role === "founder"');
    expect(actions).toContain('access.role === "ops_admin"');
    expect(monitor).toContain("Product Owner approval (no deploy)");
    expect(rehearsal).toContain("resolution_without_qa_was_not_blocked");
    expect(rehearsal).toContain("resolution_without_approval_was_not_blocked");
    expect(rehearsal).toContain("approved_resolution_material_not_persisted");
    expect(rehearsal.trimEnd()).toMatch(/rollback;$/i);
  });

  it("keeps direct API access closed and autonomous production actions absent", () => {
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
    expect(monitor).toContain("It never merges, deploys, rolls back");
    expect(monitor).not.toMatch(/vercel\s+(promote|rollback)/i);
    expect(monitor).not.toMatch(/gh\s+pr\s+merge/i);
  });
});
