/**
 * Pull the Square customers from June 14 bookings that are missing
 * in NailIQ and upsert them into client_profiles + salon_clients.
 * Then the booking backfill can import those bookings.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getSquareConfig, listBookings } from "../src/shared/integrations/square/client";
import { toCanonicalPhone } from "../src/shared/lib/toCanonicalPhone";

const SALON_SLUG = "hilite-studio";
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function sqGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://connect.squareup.com/v2${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Square-Version": "2024-12-18" },
  });
  if (!res.ok) throw new Error(`Square ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function main() {
  const { data: salon } = await db.from("salons").select("id").eq("slug", SALON_SLUG).maybeSingle();
  const salonId = (salon as { id: string }).id;
  const cfg = await getSquareConfig(db, salonId);

  // Get June 14 bookings from Square
  const begin = new Date("2026-06-19T07:00:00Z");
  const end   = new Date("2026-06-20T07:00:00Z");
  const bookings = await listBookings(cfg, begin, end);
  const missingIds = [...new Set(bookings.map((b) => b.customer_id).filter(Boolean) as string[])];

  // Check which are already in NailIQ
  const { data: existing } = await db.from("client_profiles")
    .select("square_customer_id")
    .in("square_customer_id", missingIds);
  const alreadyHave = new Set((existing as { square_customer_id: string }[] ?? []).map((r) => r.square_customer_id));
  const toImport = missingIds.filter((id) => !alreadyHave.has(id));

  console.log(`June 14 unique customers: ${missingIds.length}`);
  console.log(`Already in NailIQ: ${alreadyHave.size}`);
  console.log(`Need to import: ${toImport.length}\n`);

  for (const sqId of toImport) {
    const r = await sqGet<{ customer?: { id: string; given_name?: string; family_name?: string; phone_number?: string; email_address?: string } }>(
      `/customers/${sqId}`, cfg.accessToken
    ).catch(() => ({ customer: undefined }));

    if (!r.customer) {
      console.log(`  ⚠️  ${sqId} — not found in Square`);
      continue;
    }
    const c = r.customer;
    const name = [c.given_name, c.family_name].filter(Boolean).join(" ") || "Square Guest";
    const phone = c.phone_number ? toCanonicalPhone(c.phone_number) : null;
    const email = c.email_address ?? null;

    console.log(`  ${name}  |  phone: ${phone}  |  email: ${email}`);

    if (!phone) {
      console.log(`    ⚠️  No phone — skipping`);
      continue;
    }

    const { data: profile, error: profErr } = await db
      .from("client_profiles")
      .upsert({ phone, name, email, square_customer_id: c.id }, { onConflict: "phone" })
      .select("id")
      .maybeSingle();
    if (profErr) { console.log(`    ❌ profile: ${profErr.message}`); continue; }
    const profileId = (profile as { id: string } | null)?.id;
    if (!profileId) { console.log(`    ❌ no profile id`); continue; }

    const { error: scErr } = await db.from("salon_clients").upsert(
      { salon_id: salonId, client_profile_id: profileId, source: "square" },
      { onConflict: "salon_id,client_profile_id", ignoreDuplicates: true }
    );
    if (scErr) console.log(`    ❌ salon_client: ${scErr.message}`);
    else console.log(`    ✅ imported`);
  }

  console.log("\n✅ Done. Now re-run: npx tsx scripts/backfill-hilite-studio-bookings.ts");
}

main().catch(console.error);
