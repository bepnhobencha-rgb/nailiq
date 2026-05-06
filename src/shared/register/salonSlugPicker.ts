import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_SALON_SLUG, isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import { slugifySalonName } from "@/shared/lib/slugifySalonName";

export async function salonSlugTaken(
  supabase: SupabaseClient,
  slug: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  return Boolean(data);
}

export async function pickAvailableSalonSlug(
  supabase: SupabaseClient,
  baseSlug: string,
): Promise<{ slug: string; slugAdjusted: boolean }> {
  // Demo mode is restricted to a single shared salon at DEMO_SALON_SLUG —
  // the slug is not user-controllable and the same value is returned on
  // every demo registration. The caller (`completeSalonRegistration`)
  // handles the case where the demo salon already exists in DB.
  if (isDemoOtpRuntime()) {
    return { slug: DEMO_SALON_SLUG, slugAdjusted: false };
  }
  const normalized = slugifySalonName(baseSlug);
  if (!(await salonSlugTaken(supabase, normalized))) {
    return { slug: normalized, slugAdjusted: false };
  }
  let n = 2;
  while (n < 500) {
    const candidate = `${normalized}-${n}`;
    if (!(await salonSlugTaken(supabase, candidate))) {
      return { slug: candidate, slugAdjusted: true };
    }
    n += 1;
  }
  throw new Error("slug_candidates_exhausted");
}
