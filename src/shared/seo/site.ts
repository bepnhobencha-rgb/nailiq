/**
 * Canonical site origin for metadata, sitemap, and JSON-LD.
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_APP_URL` — canonical, set in production
 *   2. `NEXT_PUBLIC_SITE_URL` — legacy fallback (CI/preview)
 *   3. `https://www.nailiq.ca` — production default
 *
 * Accepts a full URL with scheme, or a host like `nailiq.vercel.app` (we prepend `https://`)
 * so `new URL(getSiteUrl())` in the root layout never throws.
 */
const DEFAULT_SITE_URL = "https://www.nailiq.ca";

export function getSiteUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return DEFAULT_SITE_URL;
  const sansSlash = raw.replace(/\/$/, "");
  const withScheme = /^https?:\/\//i.test(sansSlash)
    ? sansSlash
    : `https://${sansSlash}`;
  try {
    const url = new URL(withScheme);
    // www is the canonical host: the apex (nailiq.ca) 301-redirects to
    // www.nailiq.ca, so normalize here. Otherwise canonical/sitemap/JSON-LD
    // would point at a URL that immediately redirects, which weakens indexing.
    if (url.hostname === "nailiq.ca") url.hostname = "www.nailiq.ca";
    return url.origin;
  } catch {
    return DEFAULT_SITE_URL;
  }
}
