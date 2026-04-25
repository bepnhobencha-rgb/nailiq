/**
 * Canonical site origin for metadata, sitemap, and JSON-LD.
 * Set `NEXT_PUBLIC_SITE_URL` in production (no trailing slash).
 * Accepts a full URL with scheme, or a host like `nailiq.vercel.app` (we prepend `https://`)
 * so `new URL(getSiteUrl())` in the root layout never throws.
 */
export function getSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return "https://nailiq.com";
  const sansSlash = raw.replace(/\/$/, "");
  const withScheme = /^https?:\/\//i.test(sansSlash)
    ? sansSlash
    : `https://${sansSlash}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return "https://nailiq.com";
  }
}
