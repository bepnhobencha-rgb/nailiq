/**
 * Populate Wix API identifier columns for the Tech Nails tenant.
 *
 * Fetches Wix services + resources (staff) and matches them to existing
 * NailIQ rows by normalised name, then writes back the Wix IDs so the
 * forward-sync (NailIQ → Wix Create Booking) knows what to pass.
 *
 * Also stamps the wix_location_id on the wix_integrations row.
 *
 * Env (from .env.local):
 *   WIX_API_KEY                  — account API key (manage.wix.com/account/api-keys)
 *   WIX_SITE_ID                  — bca289a2-f279-4a9a-a484-c036e5f78a34
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Run:  npx tsx scripts/populate-wix-ids.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

// ---------- config ----------
const SALON_SLUG = "tech-nails";
const TECH_NAILS_LOCATION_ID = "b069f21f-7ca7-4f6c-a788-e19fe6880c09";

// ---------- env ----------
function loadEnv(): Record<string, string> {
  const root = resolve(__dirname, "..");
  const raw = readFileSync(resolve(root, ".env.local"), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return { ...env, ...process.env } as Record<string, string>;
}

const env = loadEnv();
const WIX_SITE_ID = env.WIX_SITE_ID || "bca289a2-f279-4a9a-a484-c036e5f78a34";
const WIX_API_KEY = env.WIX_API_KEY;
if (!WIX_API_KEY) throw new Error("Missing WIX_API_KEY in .env.local");

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Same provisional #N → display-name map used by wix-sync.ts.
const STAFF_NAMES: Record<number, string> = { 1: "Tina", 2: "Trish", 3: "Vi", 4: "Anna", 5: "Sally", 6: "Kim", 7: "Jenny" };

// ---------- helpers ----------
const normKey = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Resolve a Wix resource name → the NailIQ display name used during backfill. */
function resolveResourceName(wixName: string): string {
  const m = String(wixName || "").match(/#\s*(\d+)/);
  if (m) return STAFF_NAMES[Number(m[1])] ?? `Artist ${m[1]}`;
  return wixName;
}

async function wixPost(url: string, body: unknown): Promise<unknown> {
  const key = WIX_API_KEY.replace(/\s+/g, "");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key, "wix-site-id": WIX_SITE_ID },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Wix ${res.status} ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ---------- fetch Wix services ----------
type WixService = { id: string; name: string; schedule?: { id?: string }; schedules?: Array<{ id: string }> };

async function fetchWixServices(): Promise<WixService[]> {
  const r = (await wixPost("https://www.wixapis.com/bookings/v2/services/query", {
    query: { paging: { limit: 100 } },
  })) as { services?: WixService[] };
  return r.services ?? [];
}

// ---------- fetch Wix resources (staff) ----------
type WixResource = { id: string; name?: string };

async function fetchWixResources(): Promise<WixResource[]> {
  // Wix Bookings Staff/Resources lives under the bookings v1 resources path.
  const r = (await wixPost("https://www.wixapis.com/bookings/v1/resources/query", {
    query: { paging: { limit: 50 } },
    includeDeleted: false,
  })) as { resources?: WixResource[] };
  return r.resources ?? [];
}

// ---------- main ----------
async function main() {
  // Resolve salon
  const { data: salonRow, error: salonErr } = await db
    .from("salons")
    .select("id")
    .eq("slug", SALON_SLUG)
    .single();
  if (salonErr || !salonRow) throw new Error(`Salon '${SALON_SLUG}' not found: ${salonErr?.message}`);
  const salonId: string = salonRow.id;
  console.log(`Salon ID: ${salonId}`);

  // ----------------------------------------------------------------
  // A. Services
  // ----------------------------------------------------------------
  console.log("\n--- Fetching Wix services ---");
  const wixServices = await fetchWixServices();
  console.log(`Fetched ${wixServices.length} Wix services`);

  const { data: nailiqServices } = await db
    .from("services")
    .select("id,name")
    .eq("salon_id", salonId);
  const svcByNorm = new Map((nailiqServices ?? []).map((s) => [normKey(s.name), s.id]));

  let svcMatched = 0;
  const svcMissed: string[] = [];
  for (const ws of wixServices) {
    const wixServiceId = ws.id;
    // Schedule ID: prefer ws.schedule.id, fall back to ws.schedules[0].id
    const wixScheduleId = ws.schedule?.id ?? ws.schedules?.[0]?.id ?? null;
    const nailiqId = svcByNorm.get(normKey(ws.name));
    if (!nailiqId) {
      svcMissed.push(ws.name);
      continue;
    }
    const { error } = await db
      .from("services")
      .update({ wix_service_id: wixServiceId, wix_schedule_id: wixScheduleId })
      .eq("id", nailiqId);
    if (error) {
      console.error(`  ERROR updating service '${ws.name}': ${error.message}`);
    } else {
      console.log(`  [SVC] '${ws.name}' → wix_service_id=${wixServiceId}, wix_schedule_id=${wixScheduleId ?? "n/a"}`);
      svcMatched++;
    }
  }
  if (svcMissed.length) console.log(`  Unmatched Wix services (${svcMissed.length}): ${svcMissed.join(", ")}`);

  // ----------------------------------------------------------------
  // B. Staff / Resources
  // ----------------------------------------------------------------
  console.log("\n--- Fetching Wix resources (staff) ---");
  const wixResources = await fetchWixResources();
  console.log(`Fetched ${wixResources.length} Wix resources`);

  const { data: nailiqStaff } = await db
    .from("staff")
    .select("id,name")
    .eq("salon_id", salonId);
  const staffByNorm = new Map((nailiqStaff ?? []).map((s) => [normKey(s.name), s.id]));

  let staffMatched = 0;
  const staffMissed: string[] = [];
  for (const wr of wixResources) {
    const rawName = wr.name ?? "";
    const name = resolveResourceName(rawName);
    const nailiqId = staffByNorm.get(normKey(name));
    if (!nailiqId) {
      staffMissed.push(`${rawName} → ${name}`);
      continue;
    }
    const { error } = await db
      .from("staff")
      .update({ wix_resource_id: wr.id })
      .eq("id", nailiqId);
    if (error) {
      console.error(`  ERROR updating staff '${name}': ${error.message}`);
    } else {
      console.log(`  [STAFF] '${rawName}' → '${name}' → wix_resource_id=${wr.id}`);
      staffMatched++;
    }
  }
  if (staffMissed.length) console.log(`  Unmatched Wix resources (${staffMissed.length}): ${staffMissed.join(", ")}`);

  // ----------------------------------------------------------------
  // C. wix_location_id on wix_integrations
  // ----------------------------------------------------------------
  console.log("\n--- Updating wix_location_id ---");
  const { error: locErr } = await db
    .from("wix_integrations")
    .update({ wix_location_id: TECH_NAILS_LOCATION_ID })
    .eq("salon_id", salonId);
  if (locErr) {
    console.error(`  ERROR updating wix_location_id: ${locErr.message}`);
  } else {
    console.log(`  wix_location_id = ${TECH_NAILS_LOCATION_ID} ✓`);
  }

  // ----------------------------------------------------------------
  // Summary
  // ----------------------------------------------------------------
  console.log(`
=== Summary ===
Services  : ${svcMatched} / ${wixServices.length} matched + updated
Staff     : ${staffMatched} / ${wixResources.length} matched + updated
Location  : ${locErr ? "FAILED" : "updated"}
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
