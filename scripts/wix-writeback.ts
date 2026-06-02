/**
 * Phase 2 — NailIQ → Wix write-back (standalone reverse-sync).
 *
 * When a receptionist acts on a synced booking inside NailIQ, push the action to Wix:
 *   - NailIQ status 'cancelled'  while Wix is active (CONFIRMED/PENDING/CREATED) → Wix Cancel
 *   - NailIQ status 'confirmed'  while Wix is PENDING/CREATED                    → Wix Confirm
 * Mapping comes from the forward-sync state file (wixId ↔ nailiqId).
 *
 * Usage:
 *   npx tsx scripts/wix-writeback.ts                 # scan all mapped bookings, push divergences
 *   npx tsx scripts/wix-writeback.ts --demo <wixId> <confirm|cancel>
 *        # demo: set the NailIQ row to confirmed/cancelled (simulating a receptionist click),
 *        #       then push that action to Wix. Prints Wix status before/after.
 *
 * NOTE: confirm/cancel require the Wix API key to have Bookings *Manage* (write) scope,
 * not just Read. A 403 means the key needs write permission regenerated.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const ROOT = resolve(__dirname, "..");
const STATE_PATH = resolve(ROOT, "tmp/wix-sync-state.json");
const SALON_SLUG = "tech-nails";
const API = "https://www.wixapis.com/bookings/v2/bookings";
const READER = "https://www.wixapis.com/bookings/bookings-reader/v2/extended-bookings/query";

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
const KEY = env.WIX_API_KEY, SITE = env.WIX_SITE_ID || "bca289a2-f279-4a9a-a484-c036e5f78a34";
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const H = { "Content-Type": "application/json", Authorization: KEY, "wix-site-id": SITE };

async function wixBooking(id: string): Promise<{ status: string; revision: string } | null> {
  const res = await fetch(READER, { method: "POST", headers: H, body: JSON.stringify({ query: { filter: { id } } }) });
  if (!res.ok) throw new Error(`Wix read ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const b = (await res.json()).extendedBookings?.[0]?.booking;
  return b ? { status: b.status, revision: b.revision } : null;
}
async function wixAction(id: string, action: "confirm" | "cancel", revision: string) {
  const res = await fetch(`${API}/${id}/${action}`, {
    method: "POST", headers: H,
    body: JSON.stringify({ participantNotification: { notifyParticipants: false }, bookingId: id, revision }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Wix ${action} ${res.status}: ${body.slice(0, 240)}`);
  return JSON.parse(body).booking;
}

function loadState() { return JSON.parse(readFileSync(STATE_PATH, "utf8")) as { map: Record<string, string | { id: string }> }; }
const mappedId = (v: string | { id: string }) => (typeof v === "string" ? v : v.id);

// Decide the reverse action from (NailIQ status, Wix status). null = nothing to push.
function reverseAction(nailiq: string, wix: string): "confirm" | "cancel" | null {
  const w = (wix || "").toUpperCase();
  if (nailiq === "cancelled" && ["CONFIRMED", "PENDING", "CREATED", "WAITING_LIST"].includes(w)) return "cancel";
  if (nailiq === "confirmed" && ["PENDING", "CREATED", "WAITING_LIST"].includes(w)) return "confirm";
  return null;
}

async function pushOne(wixId: string, nailiqId: string): Promise<string> {
  const { data: nq } = await db.from("bookings").select("status,client_name").eq("id", nailiqId).maybeSingle();
  if (!nq) return `skip ${wixId.slice(0, 8)} (no NailIQ row)`;
  const wix = await wixBooking(wixId);
  if (!wix) return `skip ${wixId.slice(0, 8)} (no Wix booking)`;
  const action = reverseAction(nq.status, wix.status);
  if (!action) return `· ${nq.client_name}: NailIQ=${nq.status} Wix=${wix.status} → in sync`;
  const after = await wixAction(wixId, action, wix.revision);
  return `✓ ${nq.client_name}: NailIQ=${nq.status} → Wix ${action} → Wix now ${after.status}`;
}

async function main() {
  if (!KEY) throw new Error("Missing WIX_API_KEY");
  const args = process.argv.slice(2);
  const state = loadState();

  if (args[0] === "--demo") {
    const wixId = args[1];
    const action = args[2] === "cancel" ? "cancelled" : "confirmed";
    const nailiqId = mappedId(state.map[wixId]);
    if (!nailiqId) throw new Error(`wixId ${wixId} not in sync map`);
    const before = await wixBooking(wixId);
    console.log(`Wix status BEFORE: ${before?.status}`);
    // simulate the receptionist clicking confirm/cancel on the NailIQ board:
    await db.from("bookings").update({ status: action }).eq("id", nailiqId);
    console.log(`NailIQ set → ${action} (simulated receptionist click)`);
    console.log(await pushOne(wixId, nailiqId));
    const after = await wixBooking(wixId);
    console.log(`Wix status AFTER:  ${after?.status}`);
    return;
  }

  // scan mode: reconcile every mapped booking
  const { data: salon } = await db.from("salons").select("id").eq("slug", SALON_SLUG).single();
  void salon;
  let pushed = 0;
  for (const [wixId, v] of Object.entries(state.map)) {
    try {
      const line = await pushOne(wixId, mappedId(v));
      if (line.startsWith("✓")) { pushed++; console.log(line); }
    } catch (e) { console.error(`ERR ${wixId.slice(0, 8)}:`, (e as Error).message); }
  }
  console.log(`write-back done · ${pushed} action(s) pushed to Wix`);
}
main().catch((e) => { console.error("WRITEBACK FAILED:", e.message); process.exit(1); });
