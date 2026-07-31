#!/usr/bin/env node
// Copyright: internal
// Purpose: migrate existing salons to use Resend outbound email support.
// Default: dry-run only. Use --apply to perform actual updates.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = new Set(process.argv.slice(2));
const shouldApply = args.has("--apply");
const includeArchived = args.has("--include-archived");
const failIfRemaining = args.has("--fail-if-remaining") || !args.has("--no-fail-if-remaining");
const outputJson = args.has("--json");
const rawSampleLimit = Number.parseInt(process.env.RESEND_MIGRATION_SAMPLE_LIMIT ?? "20", 10);
const sampleLimit = Number.isFinite(rawSampleLimit) && rawSampleLimit > 0 ? rawSampleLimit : 20;

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, m[1])) {
      process.env[m[1]] = v;
    }
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

function emitResult(result) {
  if (!outputJson) return;
  console.log(JSON.stringify(result, null, 2));
}

function formatSalonRow(salon) {
  const slug = salon.slug || "(no-slug)";
  const name = salon.name?.trim() || "(no-name)";
  return `${slug} — ${name} (${salon.id})`;
}

async function run() {
  const baseWhere = supabase
    .from("salons")
    .select("id, slug, name")
    .eq("email_outbound_enabled", false)
    .order("created_at", { ascending: true });

  const targetQuery = includeArchived ? baseWhere : baseWhere.is("archived_at", null);
  const { data: targets, error: targetError } = await targetQuery;

  if (targetError) {
    console.error("❌ Không đọc được danh sách salon:", targetError.message ?? targetError);
    process.exit(1);
  }

  const count = targets?.length ?? 0;
  console.log(
    `🔎 Tìm thấy ${count} salon có email_outbound_enabled = false${
      includeArchived ? " (kể cả archived)" : " (chưa archived)"
    }.`,
  );

  if (count > 0) {
    const sample = (targets ?? []).slice(0, sampleLimit);
    console.log(`Sample (${Math.min(sampleLimit, count)}):`);
    for (const salon of sample) {
      console.log(`- ${formatSalonRow(salon)}`);
    }
  }

  if (!shouldApply) {
    if (count === 0) {
      emitResult({
        count: 0,
        changed: 0,
        remaining: 0,
        dryRun: true,
        applied: false,
        includeArchived,
      });
      return;
    }
    console.log("ℹ️ Chưa chạy áp dụng. Gõ thêm --apply để bật email_outbound cho các salon này.");
    emitResult({
      count,
      changed: 0,
      remaining: count,
      dryRun: true,
      applied: false,
      includeArchived,
    });
    return;
  }

  const updateBuilder = includeArchived
    ? supabase
        .from("salons")
        .update({ email_outbound_enabled: true })
        .eq("email_outbound_enabled", false)
        .select("id")
    : supabase
        .from("salons")
        .update({ email_outbound_enabled: true })
        .eq("email_outbound_enabled", false)
        .is("archived_at", null)
        .select("id");

  const { data: updatedRows, error: updateError } = (await updateBuilder);
  if (updateError) {
    console.error("❌ Cập nhật thất bại:", updateError.message ?? updateError);
    process.exit(1);
  }

  const remainingQuery = includeArchived
    ? supabase
        .from("salons")
        .select("id", { count: "exact", head: true })
        .eq("email_outbound_enabled", false)
    : supabase
        .from("salons")
        .select("id", { count: "exact", head: true })
        .eq("email_outbound_enabled", false)
        .is("archived_at", null);
  const { count: remainingCount, error: remainingError } = await remainingQuery;

  if (remainingError) {
    console.error("⚠️ Cập nhật xong nhưng không kiểm tra lại được số còn lại:", remainingError.message ?? remainingError);
    process.exit(1);
  }

  const updatedCount = (updatedRows ?? []).length;
  console.log(`✅ Đã cập nhật ${updatedCount} salon.`);
  const remaining = remainingCount ?? 0;
  const success = !failIfRemaining || remaining === 0;
  if (remaining === 0) {
    console.log("✅ Không còn salon active nào có email_outbound_enabled = false.");
  } else {
    console.log(`⚠️ Vẫn còn ${remaining} salon active có email_outbound_enabled = false.`);
  }
  emitResult({
    count,
    changed: updatedCount,
    remaining,
    dryRun: false,
    applied: true,
    includeArchived,
    success,
  });
  if (!success) process.exit(1);
}

void run();
