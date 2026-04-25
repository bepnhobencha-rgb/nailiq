import { getSiteUrl } from "@/shared/seo/site";

/**
 * Public origin for “your link” in client pages.
 * Localhost uses the current tab origin so copy/open match dev; otherwise
 * `getSiteUrl()` (see `NEXT_PUBLIC_SITE_URL` for e.g. `https://nailiq.vercel.app`).
 */
export function getSiteUrlForClient(): string {
  if (typeof window !== "undefined") {
    const h = window.location.hostname;
    if (h === "localhost" || h === "127.0.0.1") {
      return window.location.origin;
    }
  }
  return getSiteUrl();
}
