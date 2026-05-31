/**
 * Display-only formatting for a booking's customer name in dashboard views.
 *
 * This NEVER mutates stored data — it only changes what the receptionist sees:
 *
 *  1. Redaction sentinel → a clean, localized label. A prior data-safety
 *     cleanup (migration 20260505100000) replaced names that failed the XSS
 *     constraints with the literal string "[removed]". Those rows still exist;
 *     showing the raw "[removed]" to staff is confusing and leaks an internal
 *     placeholder, so it renders as "Removed guest" / "Khách đã xoá".
 *
 *  2. ALL-CAPS softening → title case. Caps-lock entries ("HUY") read as
 *     shouting next to normally-cased names ("Huy"). Only a string that is
 *     ENTIRELY uppercase is softened; any name already mixed-case (e.g.
 *     "McDonald", "Huy") is left exactly as stored. Vietnamese diacritics are
 *     preserved (NFC code points lower/upper-case correctly).
 *
 * Empty/whitespace input returns "" so callers keep their own "—" fallback.
 */

/** Sentinels written by the B-06 name-safety cleanup. Compared case-insensitively. */
const REDACTION_SENTINELS = new Set(["[removed]", "[deleted]"]);

/** Title-case one whitespace-delimited token, preserving accents (NFC). */
function titleCaseToken(token: string): string {
  if (token.length === 0) return token;
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/**
 * @param raw          The stored customer name (may be null/undefined).
 * @param removedLabel Localized label for a redacted/removed customer.
 */
export function displayCustomerName(
  raw: string | null | undefined,
  removedLabel: string,
): string {
  const name = (raw ?? "").trim();
  if (name.length === 0) return "";
  if (REDACTION_SENTINELS.has(name.toLowerCase())) return removedLabel;

  // Soften ONLY fully-uppercase names (likely caps-lock). A name with any
  // lowercase letter is intentional casing → leave untouched. The
  // `!== toLowerCase()` guard skips strings with no cased letters at all
  // (digits/symbols), which have nothing to soften.
  const isAllCaps = name === name.toUpperCase() && name !== name.toLowerCase();
  if (!isAllCaps) return name;

  // Split on whitespace but keep the separators so original spacing survives.
  return name
    .split(/(\s+)/)
    .map((part) => (/^\s+$/.test(part) ? part : titleCaseToken(part)))
    .join("");
}
