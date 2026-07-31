#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = v;
  }
}

const envPath = join(process.cwd(), ".env.local");
loadEnvFile(envPath);
loadEnvFile(join(process.cwd(), ".env"));

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("❌ Thiếu NEXT_PUBLIC_SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);
const includeArchived = process.argv.includes("--include-archived");

async function main() {
  let activeQuery = supabase
    .from("salons")
    .select("id", { count: "exact", head: true })
    .eq("email_outbound_enabled", false);
  if (!includeArchived) {
    activeQuery = activeQuery.is("archived_at", null);
  }

  const totalQuery = supabase
    .from("salons")
    .select("id", { count: "exact", head: true })
    .eq("email_outbound_enabled", false);

  let sampleQuery = supabase
    .from("salons")
    .select("slug, name, id, archived_at")
    .eq("email_outbound_enabled", false)
    .order("created_at", { ascending: true })
    .limit(50);
  if (!includeArchived) {
    sampleQuery = sampleQuery.is("archived_at", null);
  }

  const [{ count: activeCount, error: activeErr }, { count: totalCount, error: totalErr }, { data: sampleActive, error: sampleErr }] =
    await Promise.all([activeQuery, totalQuery, sampleQuery]);

  if (activeErr) {
    console.error("❌ Query active count error:", activeErr.message ?? activeErr);
    process.exit(1);
  }
  if (totalErr) {
    console.error("❌ Query total count error:", totalErr.message ?? totalErr);
    process.exit(1);
  }
  if (sampleErr) {
    console.error("❌ Query sample error:", sampleErr.message ?? sampleErr);
    process.exit(1);
  }

  console.log("--- RESEND MIGRATION STATUS ---");
  console.log(`Active salons with email_outbound_enabled=false: ${activeCount ?? 0}`);
  console.log(`All salons with email_outbound_enabled=false: ${totalCount ?? 0}`);
  console.log(`Include archived in scan: ${includeArchived ? "yes" : "no"}`);

  const output = {
    active_need_resend: activeCount ?? 0,
    total_need_resend: totalCount ?? 0,
    include_archived: includeArchived,
    sample: sampleActive ?? [],
  };

  if ((output.sample?.length ?? 0) > 0) {
    console.log("\nSample:");
    for (const s of output.sample) {
      const archived = s.archived_at ? "archived" : "active";
      console.log(`- ${s.slug ?? "(no-slug)"} — ${s.name ?? "(no-name)"} (${s.id}) [${archived}]`);
    }
  }

  console.log("\nJSON:");
  console.log(JSON.stringify(output, null, 2));
}

await main();
