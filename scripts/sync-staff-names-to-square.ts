/**
 * Push NailIQ staff names onto Square beds so both sides match.
 *
 * Renames the 7 Square "BED N" team members to the 7 active NailIQ staff names
 * (Anna..Ivy) — pairing order doesn't matter (owner: "gán ai cũng được"). Also
 * links each NailIQ staff to its Square team member via square_team_member_id so
 * future syncs map bed <-> staff.
 *
 *   npx tsx scripts/sync-staff-names-to-square.ts --dry-run
 *   npx tsx scripts/sync-staff-names-to-square.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getSquareConfig, updateTeamMemberName } from "../src/shared/integrations/square/client";

const DRY_RUN = process.argv.includes("--dry-run");
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

// Square BED team_member ids in Bed 1..7 order.
const BED_TMS = [
  "TM-0aDzkyVci0JTg", // Bed 1
  "TMcWHjF7NpLhHh-d", // Bed 2
  "TMXX9-y8DOK83YJq", // Bed 3
  "TMoZv513uQiPBVPv", // Bed 4
  "TMlnUF2RhpwtXaqz", // Bed 5
  "TMxqQZuPIt8FlYhS", // Bed 6
  "TMZVLspwc2GkpH09", // Bed 7
];

async function main() {
  console.log(`\n=== Sync NailIQ staff names -> Square beds (${DRY_RUN ? "DRY RUN" : "WRITE"}) ===\n`);
  const { data: salon } = await db.from("salons").select("id").eq("slug", "hilite-anaheim").maybeSingle();
  const salonId = (salon as { id: string }).id;
  const cfg = await getSquareConfig(db, salonId);

  const { data: staffRows } = await db
    .from("staff").select("id, name").eq("salon_id", salonId).eq("status", "active").is("deleted_at", null).order("name");
  const staff = (staffRows as { id: string; name: string }[]) ?? [];
  if (staff.length < 7) throw new Error(`Expected >=7 active staff, found ${staff.length}`);

  const pairs = BED_TMS.map((tm, i) => ({ tm, bed: i + 1, staffId: staff[i].id, name: staff[i].name }));
  console.log("Mapping (Square bed -> NailIQ name):");
  for (const p of pairs) console.log(`  Bed ${p.bed} (${p.tm}) -> "${p.name}"`);

  if (DRY_RUN) { console.log(`\nDRY RUN — no writes.\n`); return; }

  console.log(`\nRenaming Square beds + linking NailIQ staff…`);
  for (const p of pairs) {
    await updateTeamMemberName(cfg, p.tm, p.name);
    const { error } = await db.from("staff").update({ square_team_member_id: p.tm }).eq("id", p.staffId);
    if (error) throw new Error(`link staff ${p.staffId}: ${JSON.stringify(error)}`);
    console.log(`  ✓ Bed ${p.bed} -> "${p.name}"`);
  }
  console.log(`\nDONE. Both sides now use ${pairs.map((p) => p.name).join(", ")}.\n`);
}
main().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
