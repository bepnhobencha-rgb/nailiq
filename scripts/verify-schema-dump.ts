/**
 * Gate for `supabase/bootstrap/schema.sql` before it may be committed.
 *
 * This repo is PUBLIC and production holds 11,226 real customers and 4,787 real
 * bookings. A dump that quietly carried rows would not be a bad commit, it would
 * be a disclosure. So the dump does not get committed on a promise — it gets
 * committed after this passes.
 *
 * Usage:  npx tsx scripts/verify-schema-dump.ts [path]
 * Exits non-zero, loudly, on anything suspicious.
 *
 * ── Why this is not a grep ────────────────────────────────────────────────────
 *
 * The obvious check is to grep for "password", "email", "phone", "secret",
 * "token", "service_role", "client_profiles". Every one of those words appears
 * dozens of times in a CORRECT schema-only dump, because they are IDENTIFIERS:
 *
 *     encrypted_password text                       -- a column name
 *     twilio_auth_token  text                       -- a column name
 *     CREATE TABLE public.client_profiles (...)     -- a table name
 *     GRANT SELECT ON ... TO service_role;          -- a required grant
 *     CREATE POLICY ... USING (auth.uid() = ...)    -- a required policy
 *
 * A checker that fails on those cries wolf on every single run, and a checker
 * that cries wolf is a checker people learn to skip — which is worse than not
 * having one. The question is never "does the word appear", it is "is there a
 * VALUE here".
 *
 * pg_dump can only emit values in three shapes, so those are what we look for:
 *
 *   1. COPY … FROM stdin  — the bulk data format (this is what --schema-only omits)
 *   2. INSERT INTO …      — the row format (pg_dump --inserts)
 *   3. A literal inside DEFAULT / CHECK / a function body that happens to BE a
 *      secret (a key someone hardcoded into the schema years ago).
 *
 * (1) and (2) are structural and unambiguous. (3) is caught by matching the
 * SHAPES of real credentials — a Stripe key, a JWT, a PEM block, a Postgres URL
 * with a password in it — not by matching English words.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(
  process.argv[2] ?? "supabase/bootstrap/schema.sql",
);

export type Finding = { line: number; rule: string; detail: string };

/** Credential SHAPES. These match values, never identifiers. */
const SECRET_SHAPES: ReadonlyArray<{ rule: string; re: RegExp }> = [
  { rule: "jwt", re: /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/ },
  { rule: "stripe-secret", re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/ },
  { rule: "stripe-webhook", re: /\bwhsec_[A-Za-z0-9]{16,}/ },
  { rule: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { rule: "openai-key", re: /\bsk-proj-[A-Za-z0-9_-]{16,}/ },
  { rule: "resend-key", re: /\bre_[A-Za-z0-9]{20,}/ },
  { rule: "square-token", re: /\bEAAA[A-Za-z0-9_-]{20,}/ },
  { rule: "wix-key", re: /\bIST\.[A-Za-z0-9]{20,}/ },
  { rule: "twilio-sid+secret", re: /\b(AC|SK)[a-f0-9]{32}\b/ },
  { rule: "supabase-secret", re: /\b(sb_secret_[A-Za-z0-9_-]{16,}|sbp_[a-f0-9]{20,})/ },
  { rule: "github-token", re: /\bghp_[A-Za-z0-9]{20,}/ },
  { rule: "google-key", re: /\bAIza[A-Za-z0-9_-]{25,}/ },
  { rule: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  {
    rule: "connection-string-with-password",
    re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]{4,}@/,
  },
];

/**
 * Statements that carry ROWS. `--schema-only` must never produce these.
 *
 * `SELECT pg_catalog.setval(...)` is deliberately NOT here: pg_dump emits it for
 * sequence positions even with --schema-only. It carries a counter, not data.
 */
const DATA_STATEMENTS: ReadonlyArray<{ rule: string; re: RegExp }> = [
  { rule: "copy-data", re: /^\s*COPY\s+[^\s(]+.*\bFROM\s+stdin\b/i },
  { rule: "insert-data", re: /^\s*INSERT\s+INTO\b/i },
];

export function scanDump(sql: string): Finding[] {
  const findings: Finding[] = [];
  const lines = sql.split("\n");

  let insideCopyBlock = false;

  lines.forEach((line, i) => {
    const lineNo = i + 1;

    // A COPY block runs until a lone "\." — every line between is customer data.
    if (insideCopyBlock) {
      if (line.trim() === "\\.") insideCopyBlock = false;
      return; // already reported at the COPY header; do not spam a finding per row
    }

    for (const { rule, re } of DATA_STATEMENTS) {
      if (re.test(line)) {
        findings.push({
          line: lineNo,
          rule,
          detail: `${line.trim().slice(0, 70)}… — this statement carries ROWS. Re-run the dump with --schema-only.`,
        });
        if (rule === "copy-data") insideCopyBlock = true;
      }
    }

    for (const { rule, re } of SECRET_SHAPES) {
      if (re.test(line)) {
        // Never echo the value itself — this output can land in a CI log.
        findings.push({
          line: lineNo,
          rule,
          detail: `a value shaped like a real credential (${rule}) is embedded in the schema — REDACTED, inspect line ${lineNo} by hand.`,
        });
      }
    }
  });

  return findings;
}

function main() {
  let sql: string;
  try {
    sql = readFileSync(path, "utf8");
  } catch {
    console.error(
      `\n✗ No dump at ${path}.\n` +
        `  Produce it first — see docs/E2E-TEST-DATABASE.md. One command.\n`,
    );
    process.exit(1);
  }

  const findings = scanDump(sql);

  const tables = (sql.match(/^CREATE TABLE /gim) ?? []).length;
  const policies = (sql.match(/^CREATE POLICY /gim) ?? []).length;
  const functions = (sql.match(/^CREATE (OR REPLACE )?FUNCTION /gim) ?? []).length;

  console.log(`\n▶ ${path}`);
  console.log(
    `  ${(sql.length / 1024).toFixed(0)} KB · ${tables} tables · ${policies} policies · ${functions} functions\n`,
  );

  if (findings.length === 0) {
    console.log("✓ Schema-only. No rows, no credentials.");
    console.log("  Safe to commit — remember to un-ignore it in .gitignore.\n");
    process.exit(0);
  }

  console.log(`✗ ${findings.length} problem(s) — DO NOT COMMIT THIS FILE:\n`);
  for (const f of findings) {
    console.log(`  line ${String(f.line).padStart(6)}  [${f.rule}]  ${f.detail}`);
  }
  console.log(
    "\n  A dump with rows in it, committed to a PUBLIC repo, is a customer-data\n" +
      "  disclosure. Re-dump with --schema-only and run this again.\n",
  );
  process.exit(1);
}

// Run the CLI only when invoked as a script, so the unit tests can import
// scanDump() without the process exiting under them.
if (process.argv[1]?.includes("verify-schema-dump")) {
  main();
}
