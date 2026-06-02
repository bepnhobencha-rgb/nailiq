/**
 * Phase 1b — Wix → NailIQ live booking sync (standalone, poll-based).
 *
 * Polls Wix Bookings (Query Extended Bookings, filtered by updatedDate) using a
 * Wix API key and upserts new/changed bookings into the NailIQ `tech-nails`
 * tenant. Idempotent via a local state file (no prod schema change yet) plus a
 * natural-key fallback (salon + start time + phone) so it never duplicates the
 * already-backfilled rows.
 *
 * Env (in .env.local):
 *   WIX_API_KEY   = <key from manage.wix.com/account/api-keys, Bookings+Contacts read>
 *   WIX_SITE_ID   = bca289a2-f279-4a9a-a484-c036e5f78a34
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (already present)
 * Optional:
 *   WIX_SYNC_SINCE = ISO time to start the first poll from (default: now)
 *
 * Run once:    npx tsx scripts/wix-sync.ts
 * Run forever: npx tsx scripts/wix-sync.ts --watch   (polls every ~120s)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const ROOT = resolve(__dirname, "..");
const STATE_PATH = resolve(ROOT, "tmp/wix-sync-state.json");
const SALON_SLUG = "tech-nails";
const POLL_MS = 120_000;
const WIX_BOOKINGS_URL = "https://www.wixapis.com/bookings/bookings-reader/v2/extended-bookings/query";

// Same provisional #N → display-name map used by the backfill, so staff resolve consistently.
const STAFF_NAMES: Record<number, string> = { 1: "Tina", 2: "Trish", 3: "Vi", 4: "Anna", 5: "Sally", 6: "Kim", 7: "Jenny" };

// ---------- env ----------
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
  return { ...env, ...process.env } as Record<string, string>;
}
const env = loadEnv();
const WIX_API_KEY = env.WIX_API_KEY;
const WIX_SITE_ID = env.WIX_SITE_ID || "bca289a2-f279-4a9a-a484-c036e5f78a34";
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ---------- helpers ----------
function canonPhone(p: unknown): string | null {
  if (!p) return null;
  const d = String(p).replace(/\D/g, "");
  return d.length < 7 ? null : "+1" + d.slice(-10);
}
const titleCase = (s: string) => s.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase()).trim();
const sanitizeName = (s: unknown): string | null => {
  if (!s) return null;
  const c = String(s).replace(/[<>{}=&;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return c || null;
};
const normKey = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const staffNum = (name: string): number | null => { const m = String(name || "").match(/#\s*(\d+)/); return m ? Number(m[1]) : null; };
const minutesBetween = (a: string, b: string) => Math.max(15, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));
function mapStatus(wix: string, startMs: number, now: number): string {
  const s = (wix || "").toUpperCase();
  if (s === "CANCELED" || s === "CANCELLED" || s === "DECLINED") return "cancelled";
  if (s === "CONFIRMED" && startMs < now) return "completed"; // past confirmed → completed so revenue counts
  if (s === "CONFIRMED") return "confirmed";
  // Wix PENDING/CREATED = awaiting business approval → keep as 'pending' so the board paints it
  // amber "needs approval". Synced rows carry verification_method='none' (see fields) so NailIQ's
  // `release-pending` cron — which only targets pending + verification_method IS NULL — skips them.
  return "pending";
}
const noteRequestsStaff = (note: string | null) => !!note && /\b(with|please|for|request|book)\b/i.test(note);

type State = { cursorUpdatedDate: string; map: Record<string, string> };
function loadState(): State {
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  return { cursorUpdatedDate: env.WIX_SYNC_SINCE || new Date().toISOString(), map: {} };
}
const saveState = (s: State) => writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));

// ---------- Wix fetch ----------
async function wixQuery(body: unknown) {
  const res = await fetch(WIX_BOOKINGS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: WIX_API_KEY, "wix-site-id": WIX_SITE_ID },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Wix ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
// Page 1 carries filter+sort; subsequent pages must send the cursor ALONE (Wix rejects filter+cursor together).
async function* iterateUpdatedSince(sinceIso: string) {
  let body: any = {
    query: {
      filter: { updatedDate: { $gte: sinceIso } },
      sort: [{ fieldName: "updatedDate", order: "ASC" }],
      cursorPaging: { limit: 50 },
    },
  };
  for (let guard = 0; guard < 200; guard++) {
    const r = await wixQuery(body);
    for (const eb of r.extendedBookings ?? []) yield eb.booking;
    const next = r.pagingMetadata?.cursors?.next;
    if (!r.pagingMetadata?.hasNext || !next) return;
    body = { query: { cursorPaging: { limit: 50, cursor: next } } };
  }
}

// ---------- resolvers (cached per run) ----------
async function buildResolvers(salonId: string) {
  const { data: svcRows } = await db.from("services").select("id,name,duration_minutes,price_cents").eq("salon_id", salonId);
  const svcByName = new Map((svcRows ?? []).map((s) => [normKey(s.name), s]));
  const { data: staffRows } = await db.from("staff").select("id,name").eq("salon_id", salonId);
  const staffByName = new Map((staffRows ?? []).map((s) => [normKey(s.name), s.id]));

  async function resolveService(title: string, durMin: number) {
    const hit = svcByName.get(normKey(title));
    if (hit) return { id: hit.id, price: hit.price_cents ?? 0 };
    const { data, error } = await db.from("services").insert({ salon_id: salonId, name: titleCase(title || "Service"), price_cents: 0, duration_minutes: Math.max(15, durMin) }).select("id").single();
    if (error) throw error;
    const rec = { id: data.id, name: titleCase(title || "Service"), price_cents: 0 } as any;
    svcByName.set(normKey(title), rec);
    return { id: data.id, price: 0 };
  }
  async function resolveStaff(wixName: string) {
    const n = staffNum(wixName);
    const name = n != null ? STAFF_NAMES[n] ?? `Artist ${n}` : sanitizeName(wixName) || "Artist";
    const hit = staffByName.get(normKey(name));
    if (hit) return hit;
    const { data, error } = await db.from("staff").insert({ salon_id: salonId, name, job_role: "nail_tech", status: "active" }).select("id").single();
    if (error) throw error;
    staffByName.set(normKey(name), data.id);
    return data.id;
  }
  return { resolveService, resolveStaff };
}

// ---------- one sync pass ----------
async function syncOnce(): Promise<{ created: number; updated: number; cursor: string }> {
  if (!WIX_API_KEY) throw new Error("Missing WIX_API_KEY in .env.local (generate at manage.wix.com/account/api-keys, grant Bookings+Contacts read)");
  const { data: salon } = await db.from("salons").select("id").eq("slug", SALON_SLUG).single();
  const salonId = salon!.id;
  const { resolveService, resolveStaff } = await buildResolvers(salonId);
  const state = loadState();
  const now = Date.now();
  let created = 0, updated = 0, maxUpdated = state.cursorUpdatedDate;

  for await (const b of iterateUpdatedSince(state.cursorUpdatedDate)) {
    const start = b.startDate || b.bookedEntity?.slot?.startDate;
    if (!start) continue;
    const end = b.endDate || b.bookedEntity?.slot?.endDate || new Date(new Date(start).getTime() + 45 * 60000).toISOString();
    const title = b.bookedEntity?.title || "Service";
    const svc = await resolveService(title, minutesBetween(start, end));
    const staffId = await resolveStaff(b.bookedEntity?.slot?.resource?.name || "");
    const ph = canonPhone(b.contactDetails?.phone);
    const note = (b.additionalFields ?? []).find((f: any) => f.label === "Add Your Message")?.value || null;
    const startMs = new Date(start).getTime();
    const status = mapStatus(b.status, startMs, now);
    const clientName = sanitizeName([b.contactDetails?.firstName, b.contactDetails?.lastName].filter(Boolean).join(" ")) || "Guest";

    // client upsert
    if (ph) await db.from("client_profiles").upsert({ phone: ph, name: clientName === "Guest" ? null : clientName, email: b.contactDetails?.email ?? null, updated_at: new Date().toISOString() }, { onConflict: "phone" });

    const fields: any = {
      salon_id: salonId, client_name: clientName, client_phone: ph, client_email: b.contactDetails?.email ?? null,
      service_id: svc.id, staff_id: staffId, start_time_utc: start, end_time_utc: end, status, source: "appointment",
      price_cents: svc.price, staff_request_note: note, staff_requested_by_client: noteRequestsStaff(note),
      verification_method: "none", // synced from Wix (no NailIQ OTP/deposit) → shields 'pending' rows from the release-pending cron
    };

    // locate existing: state map → natural key (salon+start+phone) fallback
    let bookingId = state.map[b.id] || null;
    if (!bookingId) {
      let q = db.from("bookings").select("id").eq("salon_id", salonId).eq("start_time_utc", start);
      q = ph ? q.eq("client_phone", ph) : q.is("client_phone", null);
      const { data: existing } = await q.limit(1).maybeSingle();
      if (existing?.id) bookingId = existing.id;
    }

    if (bookingId) {
      const { error } = await db.from("bookings").update(fields).eq("id", bookingId);
      if (error) console.error("PRIMARY UPD ERR", b.id.slice(0, 8), b.contactDetails?.firstName, "→", JSON.stringify(error));
      if (!error) { state.map[b.id] = bookingId; updated++; }
      else if (staffId) { const { error: e2 } = await db.from("bookings").update({ ...fields, staff_id: null }).eq("id", bookingId); if (e2) console.error("FALLBACK UPD ERR", b.id.slice(0, 8), "→", JSON.stringify(e2)); state.map[b.id] = bookingId; updated++; }
    } else {
      let { data, error } = await db.from("bookings").insert({ ...fields, no_show_risk_score: 8, created_at: new Date().toISOString() }).select("id").single();
      if (error && staffId) ({ data, error } = await db.from("bookings").insert({ ...fields, staff_id: null, no_show_risk_score: 8, created_at: new Date().toISOString() }).select("id").single());
      if (!error && data) { state.map[b.id] = data.id; created++; }
    }
    if (b.updatedDate && b.updatedDate > maxUpdated) maxUpdated = b.updatedDate;
  }

  // advance cursor 1ms past the newest updatedDate seen (avoid reprocessing the boundary row)
  state.cursorUpdatedDate = new Date(new Date(maxUpdated).getTime() + 1).toISOString();
  saveState(state);
  return { created, updated, cursor: state.cursorUpdatedDate };
}

async function main() {
  const watch = process.argv.includes("--watch");
  const stamp = () => new Date().toISOString().slice(11, 19);
  do {
    try {
      const r = await syncOnce();
      console.log(`[${stamp()}] sync: +${r.created} new, ~${r.updated} updated · cursor=${r.cursor}`);
    } catch (e) {
      console.error(`[${stamp()}] sync ERROR:`, (e as Error).message);
    }
    if (watch) await new Promise((res) => setTimeout(res, POLL_MS));
  } while (watch);
}
main();
