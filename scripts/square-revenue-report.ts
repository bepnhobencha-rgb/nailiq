/**
 * Square revenue report for Hi-Lite Anaheim (read-only).
 *
 * Pulls completed payments for the configured location over the last N months
 * and prints a monthly breakdown (gross, tips, refunds, count, avg ticket) plus
 * a grand total. No DB writes.
 *
 *   npx tsx scripts/square-revenue-report.ts [months=12]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getSquareConfig, listPayments, type SquarePayment } from "../src/shared/integrations/square/client";

const SALON_SLUG = "hilite-anaheim";
const MONTHS = Number(process.argv[2] ?? 12);
const ROOT = resolve(__dirname, "..");

function loadEnv() {
  const raw = readFileSync(resolve(ROOT, ".env.local"), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
const env = loadEnv();
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const usd = (cents: number) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const { data: salon } = await db.from("salons").select("id, name").eq("slug", SALON_SLUG).maybeSingle();
  if (!salon) throw new Error(`Salon ${SALON_SLUG} not found`);
  const cfg = await getSquareConfig(db, (salon as { id: string }).id);

  const end = new Date();
  const begin = new Date(end.getFullYear(), end.getMonth() - (MONTHS - 1), 1);

  console.log(`\n=== Hi-Lite Anaheim revenue — last ${MONTHS} months (Square location ${cfg.locationId}) ===`);
  console.log(`Window: ${begin.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}\n`);
  console.log(`Pulling payments…`);
  const payments = await listPayments(cfg, begin, end);
  const completed = payments.filter((p) => p.status === "COMPLETED");

  type Bucket = { gross: number; tips: number; refunds: number; count: number };
  const months = new Map<string, Bucket>();
  const get = (k: string) => {
    let b = months.get(k);
    if (!b) months.set(k, (b = { gross: 0, tips: 0, refunds: 0, count: 0 }));
    return b;
  };
  let tGross = 0, tTips = 0, tRefund = 0, tCount = 0;
  for (const p of completed as SquarePayment[]) {
    const key = (p.created_at ?? "").slice(0, 7); // YYYY-MM
    if (!key) continue;
    const b = get(key);
    const amt = p.amount_money?.amount ?? 0;
    const tip = p.tip_money?.amount ?? 0;
    const ref = p.refunded_money?.amount ?? 0;
    b.gross += amt; b.tips += tip; b.refunds += ref; b.count++;
    tGross += amt; tTips += tip; tRefund += ref; tCount++;
  }

  console.log(`\n${"Month".padEnd(9)}${"Gross".padStart(14)}${"Tips".padStart(12)}${"Refunds".padStart(12)}${"Txns".padStart(8)}${"Avg".padStart(11)}`);
  console.log("-".repeat(66));
  for (const key of [...months.keys()].sort()) {
    const b = months.get(key)!;
    const avg = b.count ? b.gross / b.count : 0;
    console.log(`${key.padEnd(9)}${usd(b.gross).padStart(14)}${usd(b.tips).padStart(12)}${usd(b.refunds).padStart(12)}${String(b.count).padStart(8)}${usd(avg).padStart(11)}`);
  }
  console.log("-".repeat(66));
  console.log(`${"TOTAL".padEnd(9)}${usd(tGross).padStart(14)}${usd(tTips).padStart(12)}${usd(tRefund).padStart(12)}${String(tCount).padStart(8)}${usd(tCount ? tGross / tCount : 0).padStart(11)}`);
  console.log(`\nNet (gross − refunds): ${usd(tGross - tRefund)}`);
  console.log("");
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
