import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = process.cwd();

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) {
        if (name !== "node_modules" && name !== "__tests__") visit(absolute);
      } else if (
        /\.(?:ts|tsx)$/.test(name) &&
        !/\.(?:spec|test)\.(?:ts|tsx)$/.test(name)
      ) {
        found.push(absolute);
      }
    }
  };
  visit(root);
  return found.sort();
}

type OrCall = {
  file: string;
  argument: ts.Expression | undefined;
  sourceFile: ts.SourceFile;
};

function unwrapExpression(expression: ts.Expression | undefined): ts.Expression | undefined {
  let current = expression;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function postgrestOrCalls(): OrCall[] {
  const calls: OrCall[] = [];
  for (const absolute of sourceFiles(path.join(REPO, "src"))) {
    const text = fs.readFileSync(absolute, "utf8");
    const sourceFile = ts.createSourceFile(
      absolute,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const inspect = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "or"
      ) {
        calls.push({
          file: path.relative(REPO, absolute),
          argument: node.arguments[0],
          sourceFile,
        });
      }
      ts.forEachChild(node, inspect);
    };
    inspect(sourceFile);
  }
  return calls;
}

describe("query grammar injection inventory", () => {
  it("classifies every raw PostgREST or expression and permits no new one", () => {
    const calls = postgrestOrCalls();
    const counts = Object.fromEntries(
      [...new Set(calls.map((call) => call.file))]
        .sort()
        .map((file) => [
          file,
          calls.filter((call) => call.file === file).length,
        ]),
    );

    expect(counts).toEqual({
      "src/shared/ai/analyzeChannelFailures.ts": 1,
      "src/shared/ai/lessons.ts": 1,
      "src/shared/dashboard/availabilityEngine.ts": 2,
      "src/shared/groupbooking/agentLateDecline.ts": 1,
      "src/shared/superadmin/agentCertificationActions.ts": 1,
      "src/shared/superadmin/auditLogActions.ts": 1,
      "src/shared/superadmin/releaseReviewEmail.ts": 1,
    });

    const templated = calls.filter(
      (call) => ts.isTemplateExpression(unwrapExpression(call.argument)!),
    );
    expect(templated.map((call) => call.file).sort()).toEqual([
      "src/shared/ai/analyzeChannelFailures.ts",
      "src/shared/ai/lessons.ts",
      "src/shared/dashboard/availabilityEngine.ts",
      "src/shared/dashboard/availabilityEngine.ts",
      "src/shared/superadmin/agentCertificationActions.ts",
      "src/shared/superadmin/auditLogActions.ts",
      "src/shared/superadmin/releaseReviewEmail.ts",
    ]);

    for (const call of calls) {
      const argument = unwrapExpression(call.argument);
      if (
        !argument ||
        ts.isStringLiteral(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument)
      ) {
        continue;
      }
      expect(ts.isTemplateExpression(argument)).toBe(true);
    }

    const lessons = fs.readFileSync(
      path.join(REPO, "src/shared/ai/lessons.ts"),
      "utf8",
    );
    const failures = fs.readFileSync(
      path.join(REPO, "src/shared/ai/analyzeChannelFailures.ts"),
      "utf8",
    );
    expect(lessons.indexOf("UUID_RE.test(salonId)")).toBeLessThan(
      lessons.indexOf("createServiceRoleClient()"),
    );
    expect(failures.indexOf("UUID_RE.test(salonId)")).toBeLessThan(
      failures.indexOf("createServiceRoleClient()"),
    );

    const availability = fs.readFileSync(
      path.join(REPO, "src/shared/dashboard/availabilityEngine.ts"),
      "utf8",
    );
    const certification = fs.readFileSync(
      path.join(REPO, "src/shared/superadmin/agentCertificationActions.ts"),
      "utf8",
    );
    const releaseReview = fs.readFileSync(
      path.join(REPO, "src/shared/superadmin/releaseReviewEmail.ts"),
      "utf8",
    );
    const auditLogs = fs.readFileSync(
      path.join(REPO, "src/shared/superadmin/auditLogActions.ts"),
      "utf8",
    );
    expect(availability).toContain("const nowIso = now.toISOString()");
    expect(certification).toContain("const since = new Date(");
    expect(certification).toContain(").toISOString()");
    expect(releaseReview).toContain(
      "const claimExpiredBefore = new Date(",
    );
    expect(auditLogs).toContain("RFC3339_INSTANT_RE.test(");
    expect(auditLogs).toContain("UUID_RE.test(");
    expect(auditLogs.indexOf("if (cursor !== null && !decoded)")).toBeLessThan(
      auditLogs.indexOf("createServiceRoleClient()"),
    );
  });

  it("has no PostgREST filter call that accepts a raw grammar operator", () => {
    const unsafe: string[] = [];
    for (const absolute of sourceFiles(path.join(REPO, "src"))) {
      const sourceFile = ts.createSourceFile(
        absolute,
        fs.readFileSync(absolute, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const inspect = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "filter" &&
          node.arguments.length > 1
        ) {
          unsafe.push(path.relative(REPO, absolute));
        }
        ts.forEachChild(node, inspect);
      };
      inspect(sourceFile);
    }
    expect(unsafe).toEqual([]);
  });

  it("locks the reviewed dynamic SQL inventory to identifier-safe/static forms", () => {
    const migrationRoot = path.join(REPO, "supabase/migrations");
    const migrations = fs
      .readdirSync(migrationRoot)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const proceduralExecute: string[] = [];
    const executeFormat: string[] = [];

    for (const name of migrations) {
      const sql = fs.readFileSync(path.join(migrationRoot, name), "utf8");
      if (/^\s*execute\s+(?!function\b)/im.test(sql)) proceduralExecute.push(name);
      if (/\bexecute\s+format\s*\(/i.test(sql)) executeFormat.push(name);
      expect(sql).not.toMatch(/\bexecute\b[^;]*\|\|/i);
    }

    expect(executeFormat).toEqual([
      "20260723000000_folded_production_schema_baseline.sql",
      "20260728101931_add_campaign_preflight_freshness.sql",
      "20260728180000_restore_public_salon_slug_suggestions.sql",
    ]);
    expect(proceduralExecute).toEqual([
      "20260723000000_folded_production_schema_baseline.sql",
      "20260726213000_allow_final_booking_buffer_after_close.sql",
      "20260728101931_add_campaign_preflight_freshness.sql",
      "20260728180000_restore_public_salon_slug_suggestions.sql",
      "20260801122337_ensure_public_booking_resource_autoassign_replay.sql",
      "20260822222042_balance_salon_resource_booked_minutes.sql",
      "20260823034500_fix_staff_change_capture_btrim.sql",
      "20260823035000_fix_staff_offboarding_deferred_constraint.sql",
      "20260823037000_close_staff_deactivation_assignment_races.sql",
      "20260823124500_record_twilio_status_receipts_atomically.sql",
      "20260829174542_enable_card_safe_booking_sequences.sql",
      "20260829183626_add_multi_service_controlled_rollout.sql",
      "20260830005555_add_atomic_group_sequence_commit.sql",
    ]);

    const sequenceCardPolicy = fs.readFileSync(
      path.join(
        migrationRoot,
        "20260829174542_enable_card_safe_booking_sequences.sql",
      ),
      "utf8",
    );
    expect(sequenceCardPolicy).toContain("pg_catalog.pg_get_functiondef(");
    expect(sequenceCardPolicy).toContain("pg_catalog.replace(v_definition, v_old, v_new)");
    expect(sequenceCardPolicy).toContain(
      "'public.create_public_booking_sequence(jsonb)'::regprocedure",
    );
    expect(sequenceCardPolicy).not.toMatch(/\bexecute\s+format\s*\(/i);

    const controlledRollout = fs.readFileSync(
      path.join(
        migrationRoot,
        "20260829183626_add_multi_service_controlled_rollout.sql",
      ),
      "utf8",
    );
    expect(controlledRollout).toContain("pg_catalog.pg_get_functiondef(");
    expect(controlledRollout).toContain("EXECUTE v_definition");
    expect(controlledRollout).not.toMatch(/\bexecute\s+format\s*\(/i);
    expect(controlledRollout).not.toMatch(/\bexecute\b[^;]*\|\|/i);

    const atomicGroupSequenceCommit = fs.readFileSync(
      path.join(
        migrationRoot,
        "20260830005555_add_atomic_group_sequence_commit.sql",
      ),
      "utf8",
    );
    expect(atomicGroupSequenceCommit).toContain(
      "pg_catalog.pg_get_functiondef(",
    );
    expect(atomicGroupSequenceCommit).toContain(
      "EXECUTE pg_catalog.replace(v_definition, v_old, v_new)",
    );
    expect(atomicGroupSequenceCommit).not.toMatch(
      /\bexecute\s+format\s*\(/i,
    );
    expect(atomicGroupSequenceCommit).not.toMatch(
      /\bexecute\b[^;]*\|\|/i,
    );

    const twilioReceipts = fs.readFileSync(
      path.join(
        migrationRoot,
        "20260823124500_record_twilio_status_receipts_atomically.sql",
      ),
      "utf8",
    );
    expect(twilioReceipts).toContain(
      "'select public.record_twilio_message_status_receipt($1,$2,$3)'",
    );
    expect(twilioReceipts).toMatch(/execute[\s\S]+into v_apply[\s\S]+using/u);

    for (const name of executeFormat) {
      const sql = fs.readFileSync(path.join(migrationRoot, name), "utf8");
      expect(sql).toMatch(/%\d*\$?I/);
      expect(sql).not.toMatch(/execute\s+format\s*\([^;]*%\d*\$?s/i);
    }

    const chairBalance = fs.readFileSync(
      path.join(
        migrationRoot,
        "20260822222042_balance_salon_resource_booked_minutes.sql",
      ),
      "utf8",
    );
    expect(chairBalance).toContain("pg_catalog.pg_get_functiondef(v_function)");
    expect(chairBalance).toContain("v_match_count <> 3");
    expect(chairBalance).toContain("EXECUTE v_definition");
    expect(chairBalance).not.toMatch(/EXECUTE\s+(?:p_|NEW\.|OLD\.)/i);

    const captureRepair = fs.readFileSync(
      path.join(
        migrationRoot,
        "20260823034500_fix_staff_change_capture_btrim.sql",
      ),
      "utf8",
    );
    expect(captureRepair).toContain("pg_catalog.pg_get_functiondef(");
    expect(captureRepair).toContain("<>2 THEN");
    expect(captureRepair).toContain(
      "v_definition,'pg_catalog.trim(','pg_catalog.btrim('",
    );
    expect(captureRepair).toContain("EXECUTE v_repaired");

    const deferredConstraintRepair = fs.readFileSync(
      path.join(
        migrationRoot,
        "20260823035000_fix_staff_offboarding_deferred_constraint.sql",
      ),
      "utf8",
    );
    expect(deferredConstraintRepair).toContain("pg_catalog.pg_get_functiondef(");
    expect(deferredConstraintRepair).toContain(
      "pg_catalog.strpos(v_definition,v_immediate)=0",
    );
    expect(deferredConstraintRepair).toContain(
      "pg_catalog.strpos(v_definition,v_deferred)=0",
    );
    expect(deferredConstraintRepair).toContain(
      "pg_catalog.replace(v_definition,v_immediate,'SET CONSTRAINTS ALL IMMEDIATE;')",
    );
    expect(deferredConstraintRepair).toContain(
      "pg_catalog.replace(v_repaired,v_deferred,'SET CONSTRAINTS ALL DEFERRED;')",
    );
    expect(deferredConstraintRepair).toContain("EXECUTE v_repaired");

    const staffRaceRepair = fs.readFileSync(
      path.join(
        migrationRoot,
        "20260823037000_close_staff_deactivation_assignment_races.sql",
      ),
      "utf8",
    );
    expect(staffRaceRepair).toContain("pg_catalog.pg_get_functiondef(");
    expect(staffRaceRepair).toContain(
      "pg_catalog.strpos(v_definition,'ORDER BY s.id FOR KEY SHARE;')=0",
    );
    expect(staffRaceRepair).toContain("'ORDER BY s.id FOR UPDATE;'");
    expect(staffRaceRepair).toContain("EXECUTE v_definition");
    expect(staffRaceRepair).not.toMatch(/EXECUTE\s+(?:p_|NEW\.|OLD\.)/i);
  });
});
