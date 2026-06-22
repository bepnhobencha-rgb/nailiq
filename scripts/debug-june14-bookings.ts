/**
 * Debug: show Square bookings for June 14 2026 at hilite-studio,
 * and why each one is/isn't imported into NailIQ.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getSquareConfig, listCatalogItems, listBookings } from "../src/shared/integrations/square/client";

const SALON_SLUG = "hilite-studio";
const SERVICE_ALIASES: Record<string, string> = {
  "hotoilhairtreatment": "hotoiltreatment",
  "hotstone":            "hotstoneaddon",
  "ledlighttherapy":     "ledlighttherapymask",
  "steameyemask":        "ledlighttherapymask",
  "steamedeyemask":      "ledlighttherapymask",
  "specialpk":           "hilitespecial",
  "deluxepk":            "hilitedeluxe",
};
const norm = (s: string) =>
  s.toLowerCase().replace(/^\s*\d+\s*[-.]\s*/, "").replace(/[^a-z0-9]/g, "");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function main() {
  const { data: salon } = await db.from("salons").select("id").eq("slug", SALON_SLUG).maybeSingle();
  const salonId = (salon as { id: string }).id;
  const cfg = await getSquareConfig(db, salonId);

  const items = await listCatalogItems(cfg);
  const variationToItemName = new Map<string, string>();
  for (const it of items) for (const v of it.variations) variationToItemName.set(v.id, it.name);

  const { data: svcs } = await db.from("services").select("id, name").eq("salon_id", salonId).is("deleted_at", null);
  const svcByNorm = new Map<string, string>();
  for (const s of (svcs as { id: string; name: string }[]) ?? [])
    svcByNorm.set(norm(s.name), s.name);

  // June 14 PT = June 14 07:00 UTC to June 15 07:00 UTC
  const begin = new Date("2026-06-19T07:00:00Z");
  const end   = new Date("2026-06-20T07:00:00Z");
  const bookings = await listBookings(cfg, begin, end);
  console.log(`\nSquare bookings on June 14 (PT): ${bookings.length}\n`);

  const customerIds = [...new Set(bookings.map((b) => b.customer_id).filter(Boolean) as string[])];
  const clientBySqId = new Map<string, string>();
  if (customerIds.length) {
    const { data } = await db.from("client_profiles").select("square_customer_id, name, phone")
      .in("square_customer_id", customerIds);
    for (const r of (data as { square_customer_id: string; name: string; phone: string }[]) ?? [])
      clientBySqId.set(r.square_customer_id, `${r.name} (${r.phone})`);
  }

  for (const b of bookings) {
    const seg = b.appointment_segments?.[0];
    const itemName = seg?.service_variation_id ? variationToItemName.get(seg.service_variation_id) : undefined;
    const normName = itemName ? norm(itemName) : undefined;
    const resolvedName = normName ? (SERVICE_ALIASES[normName] ?? normName) : undefined;
    const svcMatch = resolvedName ? svcByNorm.get(resolvedName) : undefined;
    const client = b.customer_id ? clientBySqId.get(b.customer_id) : undefined;

    const startPT = b.start_at ? new Date(b.start_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit" }) : "?";
    const status = b.status ?? "?";
    const reason = !itemName ? "❌ no service" : !svcMatch ? `❌ unmapped: "${itemName}"` : !client ? "❌ client not in NailIQ" : "✅ would import";

    console.log(`${startPT}  [${status}]  ${client ?? `SqCustomer:${b.customer_id?.slice(-6)}`}  |  ${itemName ?? "(no service)"}  →  ${reason}`);
  }
}

main().catch(console.error);
