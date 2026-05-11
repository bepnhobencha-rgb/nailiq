/**
 * Brand-color contrast helpers for the booking page CTA pill.
 *
 * Some salons pick a pastel / cream brand color (e.g. `#E8D8B8`). In
 * light mode the booking page background is near-white, so a light
 * brand-colored CTA washes out and becomes hard to spot. Server
 * computes a `--cta-color` once per page render: if the salon's
 * brand passes WCAG AA on white we use it as-is, otherwise we walk
 * HSL Lightness down until it does (or bottom out at L=20%).
 *
 * Accent uses of the brand (calendar dots, price labels, step
 * indicators, focus rings) continue to use `--brand` directly —
 * darkening those would defeat their decorative purpose. Only the
 * big Continue / Confirm pill swaps to `--cta-color`.
 */

export type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb | null {
  const cleaned = String(hex ?? "").trim().replace(/^#/, "");
  if (cleaned.length !== 6) return null;
  if (!/^[0-9a-f]{6}$/i.test(cleaned)) return null;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  return [r, g, b];
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

/** Returns `[h (0–360), s (0–100), l (0–100)]`. Invalid input → [0,0,0]. */
export function hexToHsl(hex: string): [number, number, number] {
  const rgb = hexToRgb(hex);
  if (!rgb) return [0, 0, 0];
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

export function hslToHex(h: number, s: number, l: number): string {
  const sNorm = Math.max(0, Math.min(100, s)) / 100;
  const lNorm = Math.max(0, Math.min(100, l)) / 100;
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lNorm - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) {
    r = c;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = c;
  } else if (hue < 180) {
    g = c;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = c;
  } else if (hue < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return rgbToHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

function srgbChannelToLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * srgbChannelToLinear(rgb[0]) +
    0.7152 * srgbChannelToLinear(rgb[1]) +
    0.0722 * srgbChannelToLinear(rgb[2])
  );
}

/** WCAG 2.x contrast ratio between two hex colors (1:1 .. 21:1). */
export function contrastRatio(hex1: string, hex2: string): number {
  const a = hexToRgb(hex1);
  const b = hexToRgb(hex2);
  if (!a || !b) return 1;
  const La = relativeLuminance(a);
  const Lb = relativeLuminance(b);
  const [lighter, darker] = La > Lb ? [La, Lb] : [Lb, La];
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA threshold for normal-weight body text. Large/bold UI text
 *  passes at 3:1, but we hold the CTA pill to the stricter bar so it
 *  reads cleanly on a near-white page background in light mode. */
const WCAG_AA_NORMAL = 4.5;
/** Hard floor for the darken loop — anything below ~L=20 is
 *  effectively a black smudge and loses brand identity entirely. */
const MIN_LIGHTNESS = 20;
/** Step size for the lightness decrement. 5% per iteration keeps the
 *  loop at most ~16 steps from full L=100. */
const DARKEN_STEP = 5;

/**
 * Returns the best CTA-button color for the given brand hex.
 * - Sufficient contrast on white (≥ 4.5:1) → returns the brand color
 *   as-is (upper-cased).
 * - Insufficient contrast → walks HSL Lightness down by 5% steps
 *   until contrast clears 4.5:1, or bottoms out at L=20%.
 * - Invalid hex → returns the original string unchanged so the caller
 *   never crashes on bad input.
 */
export function getCtaColor(brandHex: string): string {
  const trimmed = String(brandHex ?? "").trim();
  if (!hexToRgb(trimmed)) return brandHex;
  if (contrastRatio(trimmed, "#FFFFFF") >= WCAG_AA_NORMAL) {
    return trimmed.toUpperCase();
  }
  const [h, s, lInit] = hexToHsl(trimmed);
  let l = lInit;
  while (l > MIN_LIGHTNESS) {
    l = Math.max(MIN_LIGHTNESS, l - DARKEN_STEP);
    const candidate = hslToHex(h, s, l);
    if (contrastRatio(candidate, "#FFFFFF") >= WCAG_AA_NORMAL) {
      return candidate;
    }
    if (l === MIN_LIGHTNESS) break;
  }
  return hslToHex(h, s, MIN_LIGHTNESS);
}
