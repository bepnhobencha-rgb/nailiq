import type { SupabaseClient } from "@supabase/supabase-js";
import { slugifySalonName } from "@/shared/lib/slugifySalonName";

// TODO(companion): When isDemoOtpRuntime(), force slug to DEMO_SALON_SLUG ("demo-salon")
// See: security fix PR — demo cookie now only works for demo-salon slug

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
