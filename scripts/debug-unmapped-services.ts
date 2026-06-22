import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getSquareConfig, listCatalogItems } from "../src/shared/integrations/square/client";

const SALON_SLUG = "hilite-studio";
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const norm = (s: string) =>
  s.toLowerCase().replace(/^\s*\d+\s*[-.]\s*/, "").replace(/[^a-z0-9]/g, "");

async function main() {
  const { data: salon } = await db.from("salons").select("id").eq("slug", SALON_SLUG).maybeSingle();
  const salonId = (salon as { id: string }).id;
  const cfg = await getSquareConfig(db, salonId);
  const items = await listCatalogItems(cfg);

  const { data: svcs } = await db.from("services").select("name").eq("salon_id", salonId).is("deleted_at", null);
  const nailiqNames = new Set((svcs as { name: string }[]).map((s) => norm(s.name)));

  console.log("=== Square catalog items NOT mapped to NailIQ services ===");
  for (const item of items) {
    if (!nailiqNames.has(norm(item.name))) {
      console.log(` ✗  "${item.name}"  →  norm: "${norm(item.name)}"`);
    } else {
      console.log(` ✓  "${item.name}"`);
    }
  }
}

main().catch(console.error);
