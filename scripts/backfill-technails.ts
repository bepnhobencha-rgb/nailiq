/**
 * Tech Nails → NailIQ backfill (demo tenant).
 *
 * Reads slim Wix exports from tmp/wix-backfill/*.json and seeds a NailIQ
 * tenant: salon + services + staff + client_profiles + bookings, then a
 * vibrant "demo week" schedule built from REAL clients/services/staff, and
 * finally links Huy's account as owner so he can open the Receptionist Center.
 *
 * Idempotent: re-running wipes only this salon's seeded rows (matched by
 * salon_id and `idempotency_key` prefixes) and re-creates them.
 *
 * Run:  npx tsx scripts/backfill-technails.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { categorizeService } from "../src/shared/integrations/wix/categorize";

// ---------- config ----------
const ROOT = resolve(__dirname, "..");
const DATA = resolve(ROOT, "tmp/wix-backfill");
const OWNER_EMAIL = "thehuytgvn@gmail.com";
const SALON = {
  name: "Tech Nails Salon",
  slug: "tech-nails",
  phone: "+17788580000", // placeholder — real salon phone unknown (owner to confirm)
  address: "20631 Fraser Hwy, Langley City, BC V3A 4G5, Canada",
  timezone: "America/Vancouver",
  currency_code: "CAD",
  plan_override: "premium", // demo tenant → unlimited bookings/staff/services, no upsell banner
};
// Provisional staff display names (Wix anonymises techs as "Staff Member #N").
// Names sourced from real client request notes; mapping #→name is a guess the
// owner can fix in one click. The literal request is preserved per-booking.
const STAFF_NAMES: Record<number, { name: string; job_role: string }> = {
  1: { name: "Tina", job_role: "owner" },
  2: { name: "Trish", job_role: "senior" },
  3: { name: "Vi", job_role: "senior" },
  4: { name: "Anna", job_role: "nail_tech" },
  5: { name: "Sally", job_role: "nail_tech" },
  6: { name: "Kim", job_role: "nail_tech" },
  7: { name: "Jenny", job_role: "nail_tech" },
};

// ---------- env ----------
function loadEnv() {
  const raw = readFileSync(resolve(ROOT, ".env.local"), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error("Missing Supabase env in .env.local");
const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------- helpers ----------
const J = (f: string) => JSON.parse(readFileSync(resolve(DATA, f), "utf8"));
function canonPhone(p: unknown): string | null {
  if (!p) return null;
  const d = String(p).replace(/\D/g, "");
  if (d.length < 7) return null;
  return "+1" + d.slice(-10); // NANP (BC numbers)
}
const titleCase = (s: string) =>
  s.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase()).trim();
// DB CHECK (client_profiles_name_safe_check / bookings_client_name_safe_check)
// rejects [<>{}=&;] and names > 100 chars. Strip those, collapse, clamp.
function sanitizeName(s: unknown): string | null {
  if (!s) return null;
  const c = String(s).replace(/[<>{}=&;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return c || null;
}
function staffNumFromName(name: string): number | null {
  const m = String(name || "").match(/#\s*(\d+)/);
  return m ? Number(m[1]) : null;
}
const minutesBetween = (a: string, b: string) =>
  Math.max(15, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));

type WixService = { wixId: string; name: string; priceCents: number | null; currency: string | null; durationMinutes: number | null; category: string | null; hidden?: boolean };
type WixContact = { wixContactId: string; firstName: string; lastName: string; phone: string | null; email: string | null };
type WixBooking = { wixId: string; serviceId: string; title: string; startUtc: string; endUtc: string; timezone: string; staffResId: string; staffName: string; clientName: string; clientPhone: string | null; clientEmail: string | null; note: string | null; status: string };

async function main() {
  const services: WixService[] = J("services.json");
  const contacts: WixContact[] = J("contacts.json");
  // REAL bookings only: historical sample + the current/upcoming window, deduped by wixId.
  // No synthetic data — the board must mirror Wix 1:1.
  const histBks: WixBooking[] = J("bookings.json");
  let windowBks: WixBooking[] = [];
  try { windowBks = J("bookings_window.json"); } catch { windowBks = []; }
  const byId = new Map<string, WixBooking>();
  for (const b of [...histBks, ...windowBks]) if (b?.wixId) byId.set(b.wixId, b);
  const bookings = [...byId.values()];
  // Derive staff resources from the union of all real bookings (covers all #N).
  const staffRes = [...new Map(bookings.filter((b) => b.staffResId).map((b) => [b.staffResId, { wixResId: b.staffResId, wixName: b.staffName }])).values()];
  console.log(`Loaded: ${services.length} services, ${contacts.length} contacts, ${bookings.length} bookings (hist ${histBks.length} + window ${windowBks.length}, deduped), ${staffRes.length} staff resources`);

  // ---- 1. salon (upsert by slug) ----
  const nowIso = new Date().toISOString();
  let salonId: string;
  {
    const { data: existing } = await db.from("salons").select("id").eq("slug", SALON.slug).maybeSingle();
    if (existing?.id) {
      salonId = existing.id;
      await db.from("salons").update({ ...SALON, profile_complete: true, setup_wizard_completed_at: nowIso }).eq("id", salonId);
      console.log(`Salon exists → reuse ${salonId} (wiping seeded rows)`);
      // wipe seeded children (order: bookings → services → staff). Must null
      // client_profiles.preferred_staff_id first — it FK-references staff and
      // would otherwise block the staff delete (leaving duplicates behind).
      await db.from("bookings").delete().eq("salon_id", salonId);
      const { data: oldStaff } = await db.from("staff").select("id").eq("salon_id", salonId);
      const oldStaffIds = (oldStaff ?? []).map((s) => s.id);
      if (oldStaffIds.length) await db.from("client_profiles").update({ preferred_staff_id: null }).in("preferred_staff_id", oldStaffIds);
      await db.from("services").delete().eq("salon_id", salonId);
      const { error: delStaffErr } = await db.from("staff").delete().eq("salon_id", salonId);
      if (delStaffErr) console.error("staff wipe error:", delStaffErr.message);
    } else {
      const { data, error } = await db.from("salons").insert({ ...SALON, profile_complete: true, setup_wizard_completed_at: nowIso, is_beta: true }).select("id").single();
      if (error) throw error;
      salonId = data.id;
      console.log(`Salon created → ${salonId}`);
    }
  }

  // ---- 2. staff (collapse 11 resIds → distinct #N) ----
  const numToStaffId = new Map<number, string>();
  const resToStaffId = new Map<string, string>();
  const presentNums = [...new Set(staffRes.map((s) => staffNumFromName(s.wixName)).filter((n): n is number => n != null))].sort((a, b) => a - b);
  for (const n of presentNums) {
    const meta = STAFF_NAMES[n] ?? { name: `Artist ${n}`, job_role: "nail_tech" };
    const { data, error } = await db.from("staff").insert({ salon_id: salonId, name: meta.name, job_role: meta.job_role, status: "active" }).select("id").single();
    if (error) throw error;
    numToStaffId.set(n, data.id);
  }
  for (const s of staffRes) {
    const n = staffNumFromName(s.wixName);
    if (n != null && numToStaffId.has(n)) resToStaffId.set(s.wixResId, numToStaffId.get(n)!);
  }
  console.log(`Staff created: ${numToStaffId.size}`);

  // ---- 3. services (map wixId → serviceId; create fallbacks on demand) ----
  const svcIdMap = new Map<string, { id: string; price: number; dur: number }>();
  const catCount = new Map<string, number>();
  for (const s of services) {
    const price = s.priceCents ?? 0;
    const dur = s.durationMinutes ?? 45;
    const { data, error } = await db.from("services").insert({
      salon_id: salonId,
      name: titleCase(s.name),
      price_cents: price,
      duration_minutes: dur,
      category: categorizeService(s.name), // map into a NailIQ catalog category by name
    }).select("id").single();
    if (error) throw error;
    svcIdMap.set(s.wixId, { id: data.id, price, dur });
    if (s.category) catCount.set(s.category, (catCount.get(s.category) ?? 0) + 1);
  }
  async function ensureService(wixId: string, title: string, dur: number) {
    const hit = svcIdMap.get(wixId);
    if (hit) return hit;
    const { data, error } = await db.from("services").insert({ salon_id: salonId, name: titleCase(title || "Service"), price_cents: 0, duration_minutes: Math.max(15, dur), category: categorizeService(title) }).select("id").single();
    if (error) throw error;
    const rec = { id: data.id, price: 0, dur };
    svcIdMap.set(wixId, rec);
    return rec;
  }
  console.log(`Services created: ${svcIdMap.size}`);

  // ---- 4. clients (contacts ∪ booking clients) ----
  type Client = { phone: string; name: string | null; email: string | null };
  const clients = new Map<string, Client>();
  for (const c of contacts) {
    const ph = canonPhone(c.phone);
    const name = sanitizeName([c.firstName, c.lastName].filter(Boolean).join(" "));
    if (ph) {
      const cur = clients.get(ph);
      if (!cur) clients.set(ph, { phone: ph, name, email: c.email ?? null });
      else { if (!cur.name && name) cur.name = name; if (!cur.email && c.email) cur.email = c.email; }
    }
  }
  for (const b of bookings) {
    const ph = canonPhone(b.clientPhone);
    if (!ph) continue;
    const cur = clients.get(ph);
    const bn = sanitizeName(b.clientName);
    if (!cur) clients.set(ph, { phone: ph, name: bn, email: b.clientEmail ?? null });
    else { if (!cur.name && bn) cur.name = bn; if (!cur.email && b.clientEmail) cur.email = b.clientEmail; }
  }
  // upsert client_profiles by phone (global, unique on phone)
  let clientUp = 0;
  const rows = [...clients.values()].map((c) => ({ phone: c.phone, name: c.name, email: c.email, updated_at: nowIso }));
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db.from("client_profiles").upsert(chunk, { onConflict: "phone" });
    if (error) throw error;
    clientUp += chunk.length;
  }
  console.log(`Clients upserted: ${clientUp}`);

  // ---- 5. bookings (real, imported at real dates) ----
  const now = Date.now();
  const mapStatus = (wix: string, startMs: number): string => {
    const s = (wix || "").toUpperCase();
    if (s === "CANCELED" || s === "CANCELLED" || s === "DECLINED") return "cancelled";
    if (s === "CONFIRMED" && startMs < now) return "completed";
    if (s === "CONFIRMED") return "confirmed";
    // PENDING/CREATED kept as 'pending' (amber "needs approval" on the board); rows carry
    // verification_method='none' so the release-pending cron skips them.
    return "pending";
  };
  const noteRequestsStaff = (note: string | null) => !!note && /\b(with|please|for|request|book)\b/i.test(note);

  // per-client running tallies for stats
  type Tally = { visits: number; spent: number; last: number; noshow: number; staff: Record<string, number> };
  const tally = new Map<string, Tally>();
  const bump = (ph: string | null, cents: number, startMs: number, status: string, staffId: string | null) => {
    if (!ph) return;
    const t = tally.get(ph) ?? { visits: 0, spent: 0, last: 0, noshow: 0, staff: {} };
    if (status === "cancelled") t.noshow += 1;
    else { t.visits += 1; if (status === "completed") t.spent += cents; t.last = Math.max(t.last, startMs); if (staffId) t.staff[staffId] = (t.staff[staffId] ?? 0) + 1; }
    tally.set(ph, t);
  };

  let okReal = 0, skipReal = 0;
  for (const b of bookings) {
    const start = b.startUtc, end = b.endUtc;
    if (!start) { skipReal++; continue; }
    const dur = end ? minutesBetween(start, end) : 45;
    const svc = await ensureService(b.serviceId, b.title, dur);
    const staffId = resToStaffId.get(b.staffResId) ?? null;
    const startMs = new Date(start).getTime();
    const status = mapStatus(b.status, startMs);
    const ph = canonPhone(b.clientPhone);
    const risk = Math.min(95, Math.max(3, Math.round(8 + (tally.get(ph ?? "")?.noshow ?? 0) * 18 + Math.random() * 8)));
    const row = {
      salon_id: salonId,
      client_name: sanitizeName(b.clientName) || "Guest",
      client_phone: ph,
      client_email: b.clientEmail ?? null,
      service_id: svc.id,
      staff_id: staffId,
      start_time_utc: start,
      end_time_utc: end ?? new Date(startMs + dur * 60000).toISOString(),
      status,
      source: "appointment",
      price_cents: svc.price,
      no_show_risk_score: risk,
      staff_request_note: b.note ?? null,
      staff_requested_by_client: noteRequestsStaff(b.note),
      verification_method: "none", // synced from Wix → shields 'pending' rows from the release-pending cron
      created_at: nowIso,
    };
    const { error } = await db.from("bookings").insert(row);
    if (error) {
      // overlap (GIST) or other → retry unassigned, else skip
      if (staffId) {
        const { error: e2 } = await db.from("bookings").insert({ ...row, staff_id: null });
        if (e2) { if (skipReal === 0) console.error("first real-booking error:", JSON.stringify(e2)); skipReal++; continue; }
      } else { if (skipReal === 0) console.error("first real-booking error:", JSON.stringify(error)); skipReal++; continue; }
    }
    bump(ph, svc.price, startMs, status, staffId);
    okReal++;
  }
  console.log(`Real bookings inserted: ${okReal} (skipped ${skipReal})`);

  // ---- 6. (removed) synthetic demo-week — the board now mirrors REAL Wix bookings only ----
  const okDemo = 0;

  // ---- 7. recompute client stats from tallies ----
  let statUp = 0;
  const entries = [...tally.entries()];
  for (let i = 0; i < entries.length; i += 200) {
    const chunk = entries.slice(i, i + 200);
    await Promise.all(chunk.map(async ([ph, t]) => {
      const topStaff = Object.entries(t.staff).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      await db.from("client_profiles").update({
        visit_count: t.visits,
        total_spent_cents: t.spent,
        last_service_date: t.last ? new Date(t.last).toISOString() : null,
        no_show_count: t.noshow,
        is_vip: t.visits >= 4 || t.spent >= 25000,
        preferred_staff_id: topStaff,
        updated_at: nowIso,
      }).eq("phone", ph);
      statUp++;
    }));
  }
  console.log(`Client stats updated: ${statUp}`);

  // ---- 8. link owner ----
  let ownerLinked = "not-found";
  try {
    let page = 1, userId: string | null = null;
    while (page <= 20 && !userId) {
      const { data } = await db.auth.admin.listUsers({ page, perPage: 1000 });
      const u = data?.users?.find((x) => (x.email ?? "").toLowerCase() === OWNER_EMAIL);
      if (u) userId = u.id;
      if (!data?.users?.length || data.users.length < 1000) break;
      page++;
    }
    if (userId) {
      await db.from("salon_members").delete().eq("salon_id", salonId).eq("user_id", userId);
      const { error } = await db.from("salon_members").insert({ salon_id: salonId, user_id: userId, role: "owner" });
      ownerLinked = error ? `error: ${error.message}` : `linked ${userId}`;
    }
  } catch (e) { ownerLinked = `error: ${(e as Error).message}`; }
  console.log(`Owner (${OWNER_EMAIL}): ${ownerLinked}`);

  // ---- summary ----
  const { count: bkCount } = await db.from("bookings").select("*", { count: "exact", head: true }).eq("salon_id", salonId);
  const vips = [...tally.values()].filter((t) => t.visits >= 4 || t.spent >= 25000).length;
  console.log("\n================ BACKFILL COMPLETE ================");
  console.log(`salon_id      : ${salonId}  (slug: ${SALON.slug})`);
  console.log(`services      : ${svcIdMap.size}`);
  console.log(`staff         : ${numToStaffId.size}`);
  console.log(`clients       : ${clientUp}`);
  console.log(`bookings total: ${bkCount}  (all REAL Wix; demo ${okDemo})`);
  console.log(`VIP clients   : ${vips}`);
  console.log(`service cats  : ${[...catCount.entries()].map(([k, v]) => `${k}:${v}`).join(", ")}`);
  console.log(`owner link    : ${ownerLinked}`);
  console.log(`open → /dashboard/${SALON.slug}/center`);
  console.log("==================================================");
}

main().catch((e) => { console.error("BACKFILL FAILED:", e); process.exit(1); });
