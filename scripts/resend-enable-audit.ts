/**
 * Audit/repair salons using Resend flag.
 *
 * - Default/--dry-run: only report what would change.
 * - --apply: writes (set false/null → true) and verifies the result.
 * - --json: output machine-readable JSON summary.
 *
 * Usage:
 *   npx tsx scripts/resend-enable-audit.ts --dry-run
 *   npx tsx scripts/resend-enable-audit.ts --apply
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

type Env = {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

function loadEnv() {
  const root = resolve(__dirname, "..");
  const candidates = [
    resolve(root, ".env.local"),
    resolve(root, ".env"),
    resolve(root, ".env.example"),
  ];

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const k = m[1] as keyof Env;
      let v = m[2].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (!process.env[k] && v) process.env[k] = v;
    }
  }
}

function requireEnv(name: keyof Env) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

async function main() {
  loadEnv();
  const apply = process.argv.includes("--apply");
  const explicitDryRun = process.argv.includes("--dry-run");
  const json = process.argv.includes("--json");

  if (apply && explicitDryRun) {
    throw new Error("Choose exactly one mode: --apply or --dry-run");
  }

  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const db = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: rows, error } = await db
    .from("salons")
    .select("id, slug, name, email_outbound_enabled")
    .order("slug", { ascending: true });

  if (error) throw new Error(`Unable to read salons: ${JSON.stringify(error)}`);

  const blockedRows = (rows ?? []).filter(
    (r: { email_outbound_enabled: boolean | null }) =>
      r.email_outbound_enabled !== true,
  );

  if (blockedRows.length === 0) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            total: rows?.length ?? 0,
            needRepair: 0,
            repaired: 0,
            remaining: 0,
            salons: [],
            mode: apply ? "APPLY" : "DRY_RUN",
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        "[resend-enable-audit] All salons already have email_outbound_enabled = true.",
      );
    }
    return;
  }

  if (!json) {
    console.log(
      `[resend-enable-audit] Found ${blockedRows.length}/${rows?.length ?? 0} salon rows with email_outbound_enabled != true.`,
    );
    for (const r of blockedRows) {
      console.log(
        `- ${r.slug} (${r.name}) => ${String(r.email_outbound_enabled)}`,
      );
    }
  }

  if (!apply) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            total: rows?.length ?? 0,
            needRepair: blockedRows.length,
            repaired: 0,
            remaining: blockedRows.length,
            salons: blockedRows,
            mode: "DRY_RUN",
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        "\nDRY RUN: no changes were written. Re-run with --apply to repair.",
      );
    }
    return;
  }

  let changed = 0;
  const failures: string[] = [];
  for (const row of blockedRows) {
    const { data: updated, error: upErr } = await db
      .from("salons")
      .update({ email_outbound_enabled: true })
      .eq("id", row.id)
      .or("email_outbound_enabled.eq.false,email_outbound_enabled.is.null")
      .select("id");

    if (upErr) {
      failures.push(`${row.slug}: ${upErr.message}`);
      continue;
    }

    if (updated?.length !== 1) {
      failures.push(
        `${row.slug}: row was not updated (it may have changed concurrently)`,
      );
      continue;
    }

    changed += 1;
    if (!json) console.log(`  ✓ repaired ${row.slug}`);
  }

  const candidateIds = blockedRows.map((row) => row.id);
  const { data: verifiedRows, error: verifyError } = await db
    .from("salons")
    .select("id, slug, name, email_outbound_enabled")
    .in("id", candidateIds);

  if (verifyError)
    throw new Error(
      `Unable to verify repaired salons: ${JSON.stringify(verifyError)}`,
    );

  const remaining = (verifiedRows ?? []).filter(
    (row: { email_outbound_enabled: boolean | null }) =>
      row.email_outbound_enabled !== true,
  );

  if (json) {
    console.log(
      JSON.stringify(
        {
          total: rows?.length ?? 0,
          needRepair: blockedRows.length,
          repaired: changed,
          remaining: remaining.length,
          salons: remaining,
          mode: "APPLY",
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `\n[resend-enable-audit] Repaired ${changed}/${blockedRows.length} salons; ${remaining.length} remain.`,
    );
  }

  if (failures.length > 0 || remaining.length > 0) {
    throw new Error(
      `Repair incomplete: ${[...failures, ...remaining.map((row) => `${row.slug}: still not enabled`)].join("; ")}`,
    );
  }
}

main().catch((err) => {
  console.error(
    `\nFAILED: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
