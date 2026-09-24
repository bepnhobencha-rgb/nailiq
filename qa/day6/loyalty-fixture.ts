import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../../e2e/receptionist-center/helpers";

// Only read-path fixtures. The application value-mutation gate stays OFF.
export async function seedReadOnlyLoyalty(salonId: string) {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:54321"
    || process.env.NAILIQ_DISPOSABLE_DB !== "1") throw new Error("Local QA only");
  const prior = await supabaseAdmin.from("platform_flags").select("enabled").eq("key", "feature_loyalty").maybeSingle();
  if (prior.error) throw new Error(prior.error.code);
  const flag = await supabaseAdmin.from("platform_flags").upsert({ key: "feature_loyalty", enabled: true }, { onConflict: "key" });
  if (flag.error) throw new Error(flag.error.code);
  const restore = async () => {
    const result = prior.data
      ? await supabaseAdmin.from("platform_flags").update({ enabled: prior.data.enabled }).eq("key", "feature_loyalty")
      : await supabaseAdmin.from("platform_flags").delete().eq("key", "feature_loyalty");
    if (result.error) throw new Error(result.error.code);
  };
  try {
    const salon = await supabaseAdmin.from("salons").select("feature_flags").eq("id", salonId).single();
    if (salon.error) throw new Error(salon.error.code);
    const updated = await supabaseAdmin.from("salons").update({
      plan_override: "premium", feature_flags: { ...(salon.data.feature_flags as Record<string, unknown>), loyalty_enabled: true },
    }).eq("id", salonId);
    if (updated.error) throw new Error(updated.error.code);
    const id = randomUUID();
    const program = await supabaseAdmin.from("loyalty_programs").insert({ id, salon_id: salonId, name: "QA Rewards", is_active: true, stamps_required: 10 });
    if (program.error) throw new Error(program.error.code);
    const cards = await supabaseAdmin.from("loyalty_cards").insert([
      { salon_id: salonId, program_id: id, client_phone: "+16045550148", stamps_current: 3, stamps_lifetime: 3 },
      { salon_id: salonId, program_id: id, client_phone: "+16045550149", stamps_current: 7, stamps_lifetime: 7 },
    ]);
    if (cards.error) throw new Error(cards.error.code);
    return restore;
  } catch (error) { await restore(); throw error; }
}

export async function cleanupReadOnlyLoyalty(salonId: string) {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:54321"
    || process.env.NAILIQ_DISPOSABLE_DB !== "1") throw new Error("Local QA only");
  // These legacy FKs are not cascading; remove only the fixture tenant's rows.
  for (const table of ["loyalty_stamp_events", "loyalty_cards", "loyalty_programs"] as const) {
    const result = await supabaseAdmin.from(table).delete().eq("salon_id", salonId);
    if (result.error) throw new Error(result.error.code);
  }
}
