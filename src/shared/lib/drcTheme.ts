/**
 * DRC color theme utilities.
 * Pure functions — no imports from app code, safe to use on both server and client.
 */

export const DEFAULT_DRC_ACCENT = "#c9a96e"; // NailIQ gold

export type DrcPalette = {
  accent: string;
  /** 12% opacity tint — appointment block background overlay */
  accentSubtle: string;
  /** 40% opacity — block border */
  accentBorder: string;
  /** Safe text color ON the accent bg (#000 or #fff, WCAG-calculated) */
  accentFg: string;
};

export type FengShuiPresetKey =
  | "fire_red" | "fire_orange" | "metal_gold" | "wood_green"
  | "water_blue" | "water_purple" | "earth_brown" | "nailiq_gold";

export const FENG_SHUI_PRESETS: Array<{ hex: string; key: FengShuiPresetKey }> = [
  { hex: "#c94040", key: "fire_red" },
  { hex: "#d46b2a", key: "fire_orange" },
  { hex: "#c9a030", key: "metal_gold" },
  { hex: "#2d7a4f", key: "wood_green" },
  { hex: "#2d5a8f", key: "water_blue" },
  { hex: "#7a4a9f", key: "water_purple" },
  { hex: "#8f6a3a", key: "earth_brown" },
  { hex: DEFAULT_DRC_ACCENT, key: "nailiq_gold" },
];

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").padEnd(6, "0");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance (simplified Rec. 709). Returns 0–1. */
export function getLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Returns #111 (dark) or #fff (light) — whichever is readable on bgHex. */
export function contrastFg(bgHex: string): "#111111" | "#ffffff" {
  return getLuminance(bgHex) > 0.45 ? "#111111" : "#ffffff";
}

/** Derive a full safe palette from a single accent hex. */
export function deriveDrcPalette(hex: string): DrcPalette {
  const [r, g, b] = hexToRgb(hex);
  return {
    accent: hex,
    accentSubtle: `rgba(${r},${g},${b},0.13)`,
    accentBorder: `rgba(${r},${g},${b},0.45)`,
    accentFg: contrastFg(hex),
  };
}

/** Convert palette to React inline style CSS custom properties. */
export function drcPaletteToCssVars(p: DrcPalette): React.CSSProperties {
  return {
    "--drc-accent": p.accent,
    "--drc-accent-subtle": p.accentSubtle,
    "--drc-accent-border": p.accentBorder,
    "--drc-accent-fg": p.accentFg,
  } as React.CSSProperties;
}

/** Validate a hex color string. Returns cleaned "#rrggbb" or null. */
export function sanitizeHex(raw: string): string | null {
  const clean = raw.trim().replace(/[^#0-9a-fA-F]/g, "");
  const hex = clean.startsWith("#") ? clean : `#${clean}`;
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : null;
}
