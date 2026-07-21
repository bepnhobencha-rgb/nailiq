import "server-only";

import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

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
  brand_color: string | null;
  theme_mode: string | null;
  subscription_plan: string | null;
  plan_override: string | null;
  feature_flags: unknown;
  voice_ai_enabled: boolean | null;
};

export async function loadPublicNailTryOnSalon(
  slug: string,
): Promise<PublicNailTryOnSalon | null> {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return null;

  const { data } = await createServiceRoleClient()
    .from("salons")
    .select(
      "id, slug, name, brand_color, theme_mode, subscription_plan, plan_override, feature_flags, voice_ai_enabled",
    )
    .eq("slug", normalized)
    .maybeSingle();

  const row = data as SalonFlagRow | null;
  if (!row || !isReleaseFeatureEnabled(row, "nail_tryon")) return null;

  return {
    id: row.id,
    slug: row.slug,
    name: row.name?.trim() || row.slug,
    brandColor: row.brand_color || "#c6a15b",
    themeMode: row.theme_mode === "light" ? "light" : "dark",
  };
}
