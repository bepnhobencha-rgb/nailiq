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
      "src/shared/booking/cardProtectionExceptionActions.ts": 1,
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
      "20260902225916_harden_turniq_rollout_command_idempotency.sql",
      "20260903065811_harden_turniq_shadow_rollback_availability.sql",
      "20260903075954_allow_head_spa_turniq_shadow_readiness.sql",
      "20260903083410_honor_turniq_legacy_readiness_fallback.sql",
      "20260913034721_scope_booking_otp_channel_authority.sql",
      "20260913130949_require_sms_for_phone_bound_incentives.sql",
      "20260913131209_scope_booking_crm_mutation_authority.sql",
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

    const turnIqShadowRollback = fs.readFileSync(
      path.join(
        migrationRoot,
        "20260903065811_harden_turniq_shadow_rollback_availability.sql",
      ),
      "utf8",
    );
    expect(turnIqShadowRollback).toContain("pg_catalog.pg_get_functiondef(");
    expect(turnIqShadowRollback).toContain(
      "pg_catalog.replace(v_definition, v_old, v_new)",
    );
    expect(turnIqShadowRollback).toContain(
      "'public.configure_turniq_controlled_shadow_pilot_v1(uuid,text,uuid,uuid,text,text,text,text)'::regprocedure",
    );
    expect(turnIqShadowRollback).not.toMatch(/\bexecute\s+format\s*\(/i);

    const turnIqHeadSpaReadiness = fs.readFileSync(
      path.join(
        migrationRoot,
        "20260903075954_allow_head_spa_turniq_shadow_readiness.sql",
      ),
      "utf8",
    );
    expect(turnIqHeadSpaReadiness).toContain("pg_catalog.pg_get_functiondef(");
    expect(turnIqHeadSpaReadiness).toContain(
      "pg_catalog.replace(v_definition, v_old, v_new)",
    );
    expect(turnIqHeadSpaReadiness).toContain(
      "'public.configure_turniq_controlled_shadow_pilot_v1(uuid,text,uuid,uuid,text,text,text,text)'::regprocedure",
    );
    expect(turnIqHeadSpaReadiness).not.toMatch(/\bexecute\s+format\s*\(/i);
    expect(turnIqHeadSpaReadiness).not.toMatch(/\bexecute\b[^;]*\|\|/i);

    const turnIqLegacyReadinessFallback = fs.readFileSync(
      path.join(
        migrationRoot,
        "20260903083410_honor_turniq_legacy_readiness_fallback.sql",
      ),
      "utf8",
    );
    expect(turnIqLegacyReadinessFallback).toContain(
      "pg_catalog.pg_get_functiondef(",
    );
    expect(turnIqLegacyReadinessFallback).toContain(
      "pg_catalog.replace(v_definition, v_old, v_new)",
    );
    expect(turnIqLegacyReadinessFallback).toContain(
      "'public.configure_turniq_controlled_shadow_pilot_v1(uuid,text,uuid,uuid,text,text,text,text)'::regprocedure",
    );
    expect(turnIqLegacyReadinessFallback).not.toMatch(
      /\bexecute\s+format\s*\(/i,
    );
    expect(turnIqLegacyReadinessFallback).not.toMatch(
      /\bexecute\b[^;]*\|\|/i,
    );

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

    // R07 rewrites only two literal function identities obtained from the
    // catalog. Every replacement anchor must occur exactly once before the
    // sole EXECUTE; no caller input or runtime identifier enters the statement.
    const otpAuthority = fs.readFileSync(
      path.join(migrationRoot, "20260913034721_scope_booking_otp_channel_authority.sql"),
      "utf8",
    );
    const otpPatch = otpAuthority.slice(
      otpAuthority.indexOf("DO $migration$"),
      otpAuthority.indexOf("$migration$;"),
    );
    const functionNames = otpPatch.match(/FOREACH v_name IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/);
    expect(functionNames?.[1].match(/'([^']+)'/g)).toEqual([
      "'public.create_public_booking_sequence(jsonb)'",
      "'public.create_public_group_booking_sequences(jsonb)'",
    ]);
    expect(otpPatch).toContain("IF to_regprocedure(v_name) IS NULL THEN");
    expect(otpPatch).toContain("v_def := pg_get_functiondef(to_regprocedure(v_name))");
    expect(otpPatch.match(/\/ length\(v_old\) <> 1/g)).toHaveLength(3);
    for (const anchorFailure of ["validation anchor mismatch", "profile anchor mismatch", "profile invariant mismatch"]) {
      expect(otpPatch).toContain(`RAISE EXCEPTION 'OTP authority ${anchorFailure}: %'`);
    }
    expect(otpPatch).toContain("OR strpos(v_def, v_old) < v_profile_start");
    expect(otpPatch).toContain("v_otp_session.verified_channel NOT IN (''sms'', ''email'', ''staff_attested'', ''demo'')");
    expect(otpPatch).toContain("IF v_otp_session.verified_channel = ''sms'' THEN");
    expect(otpPatch.match(/\bEXECUTE\s+v_def\s*;/g)).toHaveLength(1);
    expect(otpPatch).not.toMatch(/\bEXECUTE\s+(?:format\s*\(|p_|NEW\.|OLD\.)/i);
  });

  it("limits the SMS incentive migration to hash-checked catalog definitions and literal replacements", () => {
    const sql = fs.readFileSync(path.join(REPO, "supabase/migrations/20260913130949_require_sms_for_phone_bound_incentives.sql"), "utf8");
    const patches = [...sql.matchAll(/DO \$migration\$([\s\S]*?)\$migration\$;/g)]
      .map((match) => match[1]);
    expect(patches).toHaveLength(14);
    expect(patches.map((patch) => patch.match(/pg_get_functiondef\('public\.([a-z_]+)\([^']+\)'::regprocedure\)/)?.[1])).toEqual([
      "resolve_public_booking_pricing",
      "quote_public_booking",
      "resolve_group_booking_pricing",
      "quote_group_booking",
      "create_public_booking",
      "create_group_bookings",
      "resolve_booking_sequence_pricing_and_schedule",
      "resolve_public_group_sequence_quote",
      "create_public_booking_sequence",
      "create_public_group_booking_sequences",
      "resolve_public_deposit_payment_material",
      "load_public_deposit_payment_material",
      "claim_public_deposit_payment_operation",
      "create_public_booking_with_deposit_payment",
    ]);
    for (const patch of patches) {
      expect(patch.match(/pg_get_functiondef\(/g)).toHaveLength(1);
      expect(patch).toMatch(/IF md5\(rtrim\(v_definition, E' \\n\\r\\t'\)\) <> '[a-f0-9]{32}' THEN\s+RAISE EXCEPTION 'R09 source drift:/);
      expect(patch.match(/^\s*EXECUTE\s+([^;]+);/gm)?.map((statement) => statement.trim())).toEqual(["EXECUTE v_definition;"]);
      expect(patch.indexOf("RAISE EXCEPTION 'R09 source drift:")).toBeLessThan(patch.indexOf("EXECUTE v_definition;"));
      // Identifiers come from the literal catalog target above; replacement
      // bodies are reviewed dollar-quoted SQL, never values from a caller.
      const assignments = [...patch.matchAll(/v_definition := ([^\n]+)/g)].map((match) => match[1]);
      expect(assignments.length).toBeGreaterThan(1);
      expect(assignments[0]).toMatch(/^pg_get_functiondef\('public\.[^']+'::regprocedure\);$/);
      for (const replacement of assignments.slice(1)) {
        expect(replacement).toMatch(/^replace\(v_definition, \$old\d+\$/);
      }
      expect(patch).not.toMatch(/\bEXECUTE\s+(?:format\s*\(|p_|NEW\.|OLD\.)/i);
    }
  });

  it("limits the CRM migration to enumerated catalog targets and fail-closed source anchors", () => {
    const sql = fs.readFileSync(path.join(REPO, "supabase/migrations/20260913131209_scope_booking_crm_mutation_authority.sql"), "utf8");
    const patches = [...sql.matchAll(/DO \$(\w+)\$([\s\S]*?)\$\1\$;/g)].map((match) => match[2]);
    expect(patches).toHaveLength(6);
    const patch = patches.join("\n");
    expect([...patch.matchAll(/to_regprocedure\('([^']+)'\)/g)].map((match) => match[1])).toEqual([
      "public.create_public_booking_unlimited_14(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid)",
      "public.resolve_booking_sequence_pricing_and_schedule(jsonb,boolean)",
      "public.resolve_public_group_sequence_quote(jsonb,boolean)",
      "public.create_group_bookings(uuid,jsonb,uuid,text,text,boolean,uuid,text,uuid)",
      "public.create_public_booking_for_desk_with_staff_notification(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid,boolean,boolean,integer)",
    ]);
    expect([...patch.matchAll(/v_name:='([^']+)';/g)].map((match) => match[1])).toEqual([
      "public.create_public_booking_sequence(jsonb)",
      "public.create_public_group_booking_sequences(jsonb)",
    ]);
    expect(patch).toContain("FOREACH v_name IN ARRAY ARRAY['claim_party_slot','update_party_claim_details'] LOOP");
    expect(patch).toContain("to_regprocedure('public.'||v_name||'(text,uuid,text,text,boolean)')");
    expect([...patch.matchAll(/^\s*EXECUTE\s+([^;]+);/gm)].map((match) => match[1])).toEqual([
      "v_def", "replace(v_def,v_old,v_new)", "replace(v_def,v_old,v_new)",
      "v_def", "v_def", "v_def", "v_def", "v_def",
    ]);
    expect(patch.match(/\/length\(v_old\)<>1/g)).toHaveLength(11);
    for (const failure of [
      "single resolver anchor mismatch", "sequence early lock anchor mismatch",
      "group sequence early lock anchor mismatch", "sequence resolver anchor mismatch",
      "group sequence resolver anchor mismatch", "group sequence contact flag anchor mismatch",
      "group contact flag anchor mismatch", "desk single lock anchor mismatch",
      "desk single attach anchor mismatch", "party declaration mismatch: %",
      "party salon anchor mismatch: %", "party mutation block mismatch: %",
    ]) expect(patch).toContain(`RAISE EXCEPTION 'CRM ${failure}'`);
    expect(patch).toContain("/length(v_old)=1 THEN");
    expect(patch).toContain("OR strpos(v_def,'v_profile_id IS NULL,')>0 THEN");
    expect(patch).toContain("IF v_start=0 OR v_end<=v_start OR strpos(substr(v_def,v_start,v_end-v_start),'public.resolve_client_profile(')=0 THEN");
    expect(patch).not.toMatch(/\bEXECUTE\s+(?:format\s*\(|p_|NEW\.|OLD\.)/i);
    for (const block of patches) {
      expect(block).toContain("pg_get_functiondef(");
      expect(block.indexOf("RAISE EXCEPTION")).toBeLessThan(block.indexOf("EXECUTE "));
    }
  });
});
