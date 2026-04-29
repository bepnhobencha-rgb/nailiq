import type { SupabaseClient } from "@supabase/supabase-js";

function escapeIlikePattern(segment: string): string {
  return segment
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

export async function getSalonBySlug(
  supabase: SupabaseClient,
  slug: string,
): Promise<{
  salon: Record<string, unknown> | null;
  error: { message: string; code?: string } | null;
}> {
  console.log("[PUBLIC_BOOKING] slug:", slug);

  const { data: salonExact, error: exactErr } = await supabase
    .from("salons")
    .select("*")
    .eq("slug", slug)
    .limit(1)
    .maybeSingle();

  if (exactErr) {
    return {
      salon: null,
      error: { message: exactErr.message, code: exactErr.code },
    };
  }
  if (salonExact) {
    console.log("[PUBLIC_BOOKING] salon result:", salonExact);
    return {
      salon: salonExact as Record<string, unknown>,
      error: null,
    };
  }

  if (slug.length < 2) {
    console.log("[PUBLIC_BOOKING][FUZZY]", { slug, result: null });
    return { salon: null, error: null };
  }

  const pattern = `%${escapeIlikePattern(slug)}%`;
  const { data: fuzzy, error: fuzzyErr } = await supabase
    .from("salons")
    .select("*")
    .ilike("slug", pattern)
    .limit(1)
    .maybeSingle();

  console.log("[PUBLIC_BOOKING][FUZZY]", {
    slug,
    result: fuzzy
      ? {
          id: (fuzzy as { id?: unknown }).id,
          slug: (fuzzy as { slug?: unknown }).slug,
        }
      : null,
  });

  if (fuzzyErr) {
    return {
      salon: null,
      error: { message: fuzzyErr.message, code: fuzzyErr.code },
    };
  }

  console.log("[PUBLIC_BOOKING] salon result:", fuzzy);
  return {
    salon: (fuzzy as Record<string, unknown> | null) ?? null,
    error: null,
  };
}

/** Top similar slugs by pg_trgm (empty if RPC unavailable). */
export async function fetchSimilarSalonSlugs(
  supabase: SupabaseClient,
  inputSlug: string,
): Promise<string[]> {
  const q = inputSlug.trim();
  if (q.length < 2) return [];

  const { data, error } = await supabase.rpc("suggest_salon_slugs_by_similarity", {
    p_input: q,
  });

  if (error) {
    console.warn("[PUBLIC_BOOKING] suggest_salon_slugs", error.message);
    return [];
  }
  if (!Array.isArray(data)) return [];
  return (data as unknown[])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
}

/** Dev-only: sample slugs for debugging unknown URLs (public SELECT on salons). */
export async function fetchSampleSalonSlugs(
  supabase: SupabaseClient,
  limit = 5,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("salons")
    .select("slug")
    .order("slug", { ascending: true })
    .limit(limit);

  if (error || !data?.length) return [];
  return data
    .map((r) => String((r as { slug?: string }).slug ?? "").trim())
    .filter(Boolean);
}
