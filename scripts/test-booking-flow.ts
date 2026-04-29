import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { resolvePublicBookingPage } from "@/shared/booking/resolvePublicBookingPage";

/** Best-effort: same vars as Next when running `npx tsx` (no automatic .env.local). */
function loadEnvLocalIfPresent() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvLocalIfPresent();

if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  console.warn("[TEST] Missing Supabase env");
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

async function testCase(name: string, slug: string) {
  console.log("\n========================");
  console.log("TEST:", name);
  console.log("INPUT:", slug);

  const result = await resolvePublicBookingPage(slug, supabase);

  console.log("OUTPUT:", result);

  if (result.status === "ok") {
    console.log("✅ OK FLOW");
  } else if (result.status === "redirect") {
    console.log("🔁 REDIRECT:", result.to);
  } else if (result.status === "not_found") {
    console.log("❌ NOT FOUND");
    console.log("Suggestions:", result.suggestedSlugs);
  } else if (result.status === "reserved") {
    console.log("⛔ RESERVED");
  }
}

async function run() {
  // 1. VALID SLUG
  await testCase("VALID", "liam-nails");

  // 2. WRONG CASE
  await testCase("CASE MISMATCH", "Liam-Nails");

  // 3. PARTIAL SLUG
  await testCase("FUZZY INPUT", "liam");

  // 4. NOT EXIST
  await testCase("NOT EXIST", "abcxyz123");

  // 5. RESERVED
  await testCase("RESERVED", "login");

  // 6. INVALID
  await testCase("INVALID SHORT", "a");
}

run();