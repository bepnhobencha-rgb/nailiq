/**
 * Branded canvas — derive the public booking page surface palette from the
 * salon's `brand_color` instead of a flat hardcoded background.
 *
 * The whole booking page (background, cards, inputs, hairline borders) gets a
 * very low-percentage `color-mix` of the tenant's brand color so the page
 * echoes their brand tone. This makes the hand-off from a tenant's own website
 * (their colour world) to the NailIQ booking link feel like one continuous
 * brand rather than dropping onto a generic off-white template.
 *
 * Tint strength is ADAPTIVE to the brand colour's relative luminance so every
 * colour lands well and text contrast is preserved:
 *   - Light theme: a dark/saturated brand on a near-white canvas would darken
 *     the page and erode contrast with the fixed dark text, so it gets LESS
 *     tint; a bright/airy brand stays light, so it can take a touch MORE.
 *   - Dark theme: the inverse — a bright brand on a near-black canvas gets less
 *     tint to keep light text readable.
 *
 * Text, muted-text and the (deliberately monochrome) CTA stay FIXED — only the
 * surfaces are tinted — so the WCAG contrast budget is never spent on the tint.
 */

/** WCAG relative luminance (0 = black, 1 = white) for a #RRGGBB literal.
 *  Input is assumed already normalized (see `normalizeBrandColor`). */
function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5; // neutral fallback — keeps tint mid-range for bad input
  const int = parseInt(m[1], 16);
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = toLinear((int >> 16) & 0xff);
  const g = toLinear((int >> 8) & 0xff);
  const b = toLinear(int & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export type BookingThemeVars = {
  "--booking-bg": string;
  "--booking-bg-card": string;
  "--booking-bg-input": string;
  "--booking-text": string;
  "--booking-text-muted": string;
  "--booking-border": string;
  "--cta-bg": string;
  "--cta-text": string;
};

/**
 * Build the `--booking-*` CSS custom properties for a salon's booking page.
 *
 * @param brandColor `#RRGGBB` (already normalized).
 * @param themeMode  `"light"` | `"dark"`.
 */
export function buildBookingThemeVars(
  brandColor: string,
  themeMode: "light" | "dark",
): BookingThemeVars {
  const lum = relativeLuminance(brandColor);
  const mix = (pct: number, base: string) =>
    `color-mix(in srgb, ${brandColor} ${pct}%, ${base})`;

  if (themeMode === "light") {
    // 3% (dark brand) → 7% (bright brand). Kept ≤7% so a near-white canvas
    // stays well above the contrast floor for the fixed #1a1a1a text.
    const bgPct = Math.round(clamp(3 + lum * 4, 3, 7));
    const cardPct = Math.max(1, bgPct - 2);
    const inputPct = bgPct + 2;
    return {
      "--booking-bg": mix(bgPct, "#f9f9f9"),
      "--booking-bg-card": mix(cardPct, "#ffffff"),
      "--booking-bg-input": mix(inputPct, "#f2f2f2"),
      "--booking-text": "#1a1a1a",
      // 0.6 (~#666 on white ≈ 5.7:1) meets WCAG AA 4.5:1; 0.45 failed. Still muted.
      "--booking-text-muted": "rgba(0, 0, 0, 0.6)",
      "--booking-border": mix(16, "transparent"),
      "--cta-bg": "#1a1a1a",
      "--cta-text": "#ffffff",
    };
  }

  // Dark theme: bright brand → less tint (keeps near-black canvas dark enough
  // for the fixed white text); dark brand → a touch more for visibility.
  const bgPct = Math.round(clamp(3 + (1 - lum) * 4, 3, 7));
  const cardPct = bgPct + 2;
  const inputPct = bgPct + 3;
  return {
    "--booking-bg": mix(bgPct, "#0a0a0a"),
    "--booking-bg-card": mix(cardPct, "#1c1c1e"),
    "--booking-bg-input": mix(inputPct, "#2c2c2e"),
    "--booking-text": "#ffffff",
    // 0.7 on the near-black canvas meets WCAG AA; 0.5 failed. Still muted.
    "--booking-text-muted": "rgba(255, 255, 255, 0.7)",
    "--booking-border": mix(20, "transparent"),
    "--cta-bg": "#ffffff",
    "--cta-text": "#0a0a0a",
  };
}
