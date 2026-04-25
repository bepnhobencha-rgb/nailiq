/**
 * NailIQ design tokens. CSS theme variables in `src/app/globals.css` are kept in sync
 * with `colors` here for Tailwind `nq-*` utilities.
 *
 * **Brand (locked):** Gold `primary` is for CTA, highlights, and focus only—sparingly.
 * Background / surface / text / muted are fixed: do not introduce alternate “brand”
 * primaries. Logo wordmark type on landing: mobile `text-base`–`text-lg`, desktop
 * `text-lg`–`text-xl` only; never `text-2xl`+ for the wordmark, never competing
 * with the hero `h1`.
 */
export const colors = {
  background: "#0B0C10",
  surface: "#111214",
  primary: "#D4AF37",
  primarySoft: "#F5E6B8",
  text: "#FFFFFF",
  muted: "#A1A1AA",
  error: "#EF4444",
  success: "#22C55E",
  /** Subtle gold edge for glass surfaces (CSS may use this with alpha) */
  borderSubtle: "rgba(212, 175, 55, 0.18)",
} as const;

export const spacing = {
  /** 4px */
  1: 4,
  /** 8px */
  2: 8,
  /** 12px */
  3: 12,
  /** 16px */
  4: 16,
  /** 20px */
  5: 20,
  /** 24px */
  6: 24,
  /** 32px */
  8: 32,
  /** 40px */
  10: 40,
  /** 48px */
  12: 48,
  /** 64px */
  16: 64,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 20,
  "2xl": 16,
  "3xl": 24,
  full: 9999,
} as const;

export const shadows = {
  sm: "0 1px 2px rgba(0, 0, 0, 0.35)",
  card: "0 8px 40px -12px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(212, 175, 55, 0.12)",
  /** Combined card depth + gold halo; matches `--shadow-nq-card-luxury` in `globals.css` */
  cardLuxury:
    "0 8px 40px -12px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(212, 175, 55, 0.12), 0 0 0 1px rgba(212, 175, 55, 0.14), 0 0 36px -6px rgba(212, 175, 55, 0.2)",
  inputFocus:
    "0 0 0 3px rgba(212, 175, 55, 0.32), 0 0 28px -4px rgba(212, 175, 55, 0.18)",
  /** Mirrors `--shadow-nq-input-error` in `globals.css` (token-driven focus ring) */
  inputError: "0 0 0 3px color-mix(in srgb, #ef4444 22%, transparent)",
} as const;

/** Viewport breakpoints (px). Align with Tailwind `sm`/`md`/`lg`/`xl` where applicable. */
export const breakpoints = {
  mobile: 0,
  tablet: 768,
  desktop: 1024,
  wide: 1280,
} as const;

/**
 * Layout widths and section rhythm (px). Use with `max-w-[…]` or theme CSS vars in Tailwind.
 */
export const layout = {
  mobileMax: 420,
  desktopMax: 1180,
  sectionPaddingMobile: 16,
  sectionPaddingDesktop: 32,
} as const;

export const motion = {
  duration: {
    fast: 150,
    base: 200,
    slow: 280,
  },
  easing: {
    out: "cubic-bezier(0.22, 1, 0.36, 1)",
    inOut: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
} as const;

export const typography = {
  fontFamily: {
    sans: "var(--font-geist-sans), system-ui, -apple-system, sans-serif",
    mono: "var(--font-geist-mono), ui-monospace, monospace",
  },
  size: {
    xs: [12, 16] as const,
    sm: [14, 20] as const,
    base: [16, 24] as const,
    lg: [18, 28] as const,
    xl: [20, 30] as const,
    "2xl": [24, 32] as const,
    "3xl": [30, 36] as const,
  },
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  tracking: {
    tight: -0.02,
    normal: 0,
    wide: 0.02,
  },
} as const;

export const tokens = {
  colors,
  spacing,
  breakpoints,
  layout,
  radius,
  shadows,
  motion,
  typography,
} as const;

export type NqColorKey = keyof typeof colors;
