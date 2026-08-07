/**
 * Best-effort detection of social-media in-app browsers (Instagram / Facebook /
 * TikTok / etc. WebViews) where third-party payment SDKs — notably Square's Web
 * Payments SDK — are unreliable (cross-origin script/iframe failures, blocked
 * storage). Used only to show an "open in a real browser" escape hatch on card
 * steps. It never changes payment, booking, authentication, or authorization
 * decisions.
 *
 * Pure + SSR-safe: returns false when no userAgent is available (server render),
 * and matches well-known social-app tokens plus Android's explicit WebView
 * markers. Normal mobile Safari / Chrome are never flagged.
 */
export function isInAppBrowser(ua?: string): boolean {
  const s =
    ua ??
    (typeof navigator !== "undefined" && navigator.userAgent
      ? navigator.userAgent
      : "");
  if (!s) return false;
  // Instagram: "Instagram 434.0..."; Facebook: "FBAN/FBAV/FB_IAB";
  // Android WebView: either the explicit "; wv" token or the legacy
  // "Version/4.0 ... Chrome/... Mobile Safari" shape. We only use this signal
  // to offer an external-browser escape hatch on payment-card surfaces; it is
  // never an authentication or authorization decision.
  return /Instagram|FBAN|FBAV|FB_IAB|FBIOS|Line\/|TikTok|musical_ly|Snapchat|Pinterest|Twitter|GSA\/|;\s*wv\)|\bwv\b|Version\/4\.0[^\n]*Chrome\/[^\n]*Mobile Safari/i.test(
    s,
  );
}
