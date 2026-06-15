import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { normalizeBrandColor } from "@/shared/lib/brandColor";

export type SalonPwaInfo = {
  name: string;
  /** `#RRGGBB`, already normalized. */
  brandColor: string;
  /** Up-to-2-letter initials for the generated app icon. */
  initials: string;
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]![0] : "";
  return (first + last).toUpperCase() || "NQ";
}

/**
 * Public salon identity used to brand the installable dashboard PWA
 * (manifest + generated app icon). Name + brand colour are already shown
 * on the public booking site, so reading them service-role is safe. Returns
 * null when the slug doesn't resolve so callers can fall back to NailIQ
 * defaults.
 */
export async function getSalonPwaInfo(
  slug: string,
): Promise<SalonPwaInfo | null> {
  try {
    const sb = createServiceRoleClient();
    const { data } = await sb
      .from("salons")
      .select("name, brand_color")
      .eq("slug", slug)
      .maybeSingle();
    if (!data) return null;
    const row = data as { name: string | null; brand_color: unknown };
    const name = (row.name ?? "").trim() || slug;
    return {
      name,
      brandColor: normalizeBrandColor(row.brand_color),
      initials: initialsOf(name),
    };
  } catch {
    return null;
  }
}
