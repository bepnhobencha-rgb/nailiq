/**
 * Best-effort detection of social-media in-app browsers (Instagram / Facebook /
 * TikTok / etc. WebViews) where third-party payment SDKs — notably Square's Web
 * Payments SDK — are unreliable (cross-origin script/iframe failures, blocked
 * storage). Used ONLY to show a "open in a real browser" fallback on the card
 * step AFTER the SDK has already failed to load — never to gate the happy path.
 *
 * Pure + SSR-safe: returns false when no userAgent is available (server render),
 * and matches only well-known social-app UA tokens so normal mobile Safari /
 * Chrome are never flagged.
 */
export function isInAppBrowser(ua?: string): boolean {
  const s =
    ua ??
    (typeof navigator !== "undefined" && navigator.userAgent
      ? navigator.userAgent
      : "");
  if (!s) return false;
  // Instagram: "Instagram 434.0..."; Facebook: "FBAN/FBAV/FB_IAB";
  // plus other common social WebViews. Deliberately NOT matching the bare
  // Android "; wv" token — too broad, would catch legitimate apps.
  return /Instagram|FBAN|FBAV|FB_IAB|FBIOS|Line\/|TikTok|musical_ly|Snapchat|Pinterest|Twitter|GSA\//i.test(
    s,
  );
}
