/**
 * Audit/repair salons using Resend flag.
 *
 * - Default: writes (set false → true) when needed.
 * - --dry-run: only report what would change.
 * - --json: output machine-readable JSON summary.
 *
 * Usage:
 *   npx tsx scripts/resend-enable-audit.ts --dry-run
 *   npx tsx scripts/resend-enable-audit.ts
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
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
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
  const dryRun = process.argv.includes("--dry-run");
  const json = process.argv.includes("--json");

  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: rows, error } = await db
    .from("salons")
    .select("slug, name, email_outbound_enabled")
    .order("slug", { ascending: true });

  if (error) throw new Error(`Unable to read salons: ${JSON.stringify(error)}`);

  const blockedRows = (rows ?? []).filter(
    (r: { email_outbound_enabled: boolean | null }) =>
      r.email_outbound_enabled !== true,
  );

  if (json) {
    console.log(
      JSON.stringify(
        {
          total: rows?.length ?? 0,
          needRepair: blockedRows.length,
          salons: blockedRows,
          mode: dryRun ? "DRY_RUN" : "WRITE",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (blockedRows.length === 0) {
    console.log("[resend-enable-audit] All salons already have email_outbound_enabled = true.");
    return;
  }

  console.log(`[resend-enable-audit] Found ${blockedRows.length}/${rows?.length ?? 0} salon rows with email_outbound_enabled != true.`);
  for (const r of blockedRows) {
    console.log(`- ${r.slug} (${r.name}) => ${String(r.email_outbound_enabled)}`);
  }

  if (dryRun) {
    console.log("\nDRY RUN: no changes were written. Re-run without --dry-run to repair.");
    return;
  }

  let changed = 0;
  for (const row of blockedRows) {
    const { error: upErr } = await db
      .from("salons")
      .update({ email_outbound_enabled: true })
      .eq("slug", row.slug)
      .or("email_outbound_enabled.eq.false,email_outbound_enabled.is.null");

    if (upErr) {
      console.error(`  WARN: failed to repair ${row.slug}: ${upErr.message}`);
      continue;
    }

    changed++;
    console.log(`  ✓ repaired ${row.slug}`);
  }

  console.log(`\n[resend-enable-audit] Repaired ${changed}/${blockedRows.length} salons.`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
