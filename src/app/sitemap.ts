import type { MetadataRoute } from "next";
import { createClient } from "@supabase/supabase-js";
import { getSiteUrl } from "@/shared/seo/site";

export const dynamic = "force-dynamic";

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
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const { data } = await supabase
      .from("public_salon_profiles" as never)
      .select("slug, created_at")
      .eq("profile_complete", true)
      .not("slug", "like", "e2e-%");

    if (data) {
      salonRoutes = data.map((salon: { slug: string; created_at: string | null }) => ({
        url: `${base}/${salon.slug}`,
        lastModified: salon.created_at ? new Date(salon.created_at) : now,
        changeFrequency: "weekly" as const,
        priority: 0.9,
      }));
    }
  } catch {
    // Non-fatal — static routes still served
  }

  return [...staticRoutes, ...salonRoutes];
}
