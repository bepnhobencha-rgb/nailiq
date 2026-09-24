import globalTeardown from "../../e2e/helpers/globalTeardown";
import { supabaseAdmin } from "../../e2e/receptionist-center/helpers";

export default async function teardown() {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:54321"
    || process.env.NAILIQ_DISPOSABLE_DB !== "1") throw new Error("Day 5 cleanup requires local disposable QA");
  await globalTeardown();
  // Client profiles are global, not salon-owned, so salon teardown cannot
  // cascade them. Only this test workflow's explicit synthetic name marker.
  const active = await supabaseAdmin.from("salons").select("id", { head: true, count: "exact" });
  if (active.error || active.count !== 0) throw new Error("Refuse profile cleanup while a fixture salon remains");
  const profiles = await supabaseAdmin.from("client_profiles").delete().like("name", "Te2eGuest%");
  if (profiles.error) throw new Error("Synthetic client-profile cleanup failed");
}
