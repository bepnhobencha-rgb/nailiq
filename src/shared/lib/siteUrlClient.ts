import { getSiteUrl } from "@/shared/seo/site";

/**
 * Public origin for “your link” in client pages.
 * Always `getSiteUrl()` / `NEXT_PUBLIC_SITE_URL` so server render and client
 * hydration match (no `window.location.origin` fallback).
 */
export function getSiteUrlForClient(): string {
  return getSiteUrl();
}
