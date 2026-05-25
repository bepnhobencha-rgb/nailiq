import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/shared/seo/site";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = getSiteUrl();
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: base, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/register`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/contact`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];

  let salonRoutes: MetadataRoute.Sitemap = [];
  try {
    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from("salons")
      .select("slug, updated_at")
      .is("archived_at", null)
      .eq("profile_complete", true);

    if (data) {
      salonRoutes = data.map((salon) => ({
        url: `${base}/${salon.slug}`,
        lastModified: salon.updated_at ? new Date(salon.updated_at) : now,
        changeFrequency: "weekly" as const,
        priority: 0.9,
      }));
    }
  } catch {
    // Non-fatal — static routes still served
  }

  return [...staticRoutes, ...salonRoutes];
}
