import "server-only";

import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isPublicNailTryOnEligibleSalon } from "@/shared/nailTryOn/eligibility";

export type PublicNailTryOnSalon = {
  id: string;
  slug: string;
  name: string;
  brandColor: string;
  themeMode: "light" | "dark";
};

type SalonFlagRow = {
  id: string;
  slug: string;
  name: string | null;
  archived_at: string | null;
  profile_complete: boolean | null;
  brand_color: string | null;
  theme_mode: string | null;
  subscription_plan: string | null;
  plan_override: string | null;
  feature_flags: unknown;
  voice_ai_enabled: boolean | null;
  vertical: string | null;
};

export async function loadPublicNailTryOnSalon(
  slug: string,
): Promise<PublicNailTryOnSalon | null> {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return null;

  const { data } = await createServiceRoleClient()
    .from("salons")
    .select(
      "id, slug, name, archived_at, profile_complete, brand_color, theme_mode, subscription_plan, plan_override, feature_flags, voice_ai_enabled, vertical",
    )
    .eq("slug", normalized)
    .maybeSingle();

  const row = data as SalonFlagRow | null;
  if (
    !row ||
    !isPublicNailTryOnEligibleSalon(row) ||
    !(await isReleaseFeatureVisible(row, "nail_tryon"))
  ) {
    return null;
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name?.trim() || row.slug,
    brandColor: row.brand_color || "#c6a15b",
    themeMode: row.theme_mode === "light" ? "light" : "dark",
  };
}
