import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/shared/seo/site";

export default function robots(): MetadataRoute.Robots {
  const base = getSiteUrl();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Keep auth-gated, internal, and API surfaces out of the index.
      // NOTE: /register is intentionally NOT disallowed — it's a public
      // signup landing page and is listed in sitemap.xml (priority 0.8).
      disallow: [
        "/dashboard",
        "/api",
        "/login",
        "/superadmin",
        "/choose-salon",
      ],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
