/* One-off analysis: which Square bed (team_member) each booking uses, and whether
 * same-phone-same-time "duplicates" are really group bookings on different beds. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getSquareConfig, listBookings } from "../src/shared/integrations/square/client";

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
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function main() {
  const { data: salon } = await db.from("salons").select("id").eq("slug", "hilite-anaheim").maybeSingle();
  const cfg = await getSquareConfig(db, (salon as { id: string }).id);
  const now = new Date();
  const begin = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());
  const end = new Date(now.getTime() + 60 * 86_400_000);
  const bookings = await listBookings(cfg, begin, end);

  const byBed = new Map<string, number>();
  const segCounts = new Map<number, number>();
  const groupKey = new Map<string, string[]>(); // phone|start -> [teamMemberIds]
  let multiSeg = 0;
  for (const b of bookings) {
    if (b.status?.startsWith("CANCELLED") || b.status === "NO_SHOW") continue;
    const segs = b.appointment_segments ?? [];
    segCounts.set(segs.length, (segCounts.get(segs.length) ?? 0) + 1);
    if (segs.length > 1) multiSeg++;
    const tm = segs[0]?.team_member_id ?? "(none)";
    byBed.set(tm, (byBed.get(tm) ?? 0) + 1);
    const key = `${b.customer_id ?? "?"}|${b.start_at ?? "?"}`;
    const arr = groupKey.get(key) ?? [];
    arr.push(tm);
    groupKey.set(key, arr);
  }

  console.log("\n=== Bed (team_member) usage among active bookings ===");
  for (const [tm, n] of [...byBed.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${tm}  ${n}`);
  console.log(`\ndistinct beds used: ${byBed.size}`);
  console.log("segment-count distribution:", JSON.stringify([...segCounts.entries()]));
  console.log("multi-segment bookings:", multiSeg);

  let dupSameBed = 0, dupDiffBed = 0, dupGroups = 0;
  for (const arr of groupKey.values()) {
    if (arr.length < 2) continue;
    dupGroups++;
    const uniq = new Set(arr);
    if (uniq.size === arr.length) dupDiffBed++;
    else dupSameBed++;
  }
  console.log(`\nsame customer+time groups (size>1): ${dupGroups}`);
  console.log(`  all on DIFFERENT beds (real group booking): ${dupDiffBed}`);
  console.log(`  some on SAME bed (likely true duplicate):   ${dupSameBed}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
