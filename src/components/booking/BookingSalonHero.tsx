import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";
import { BookingSalonInfoLine } from "./BookingSalonInfoLine";

/** Curated high-res salon imagery (Unsplash); used only on `lg:` and up.
 *
 * QA re-test #15: the thumbs render at ~210px wide inside the hero
 * panel but were being served at 800px (≈ 4× oversized even at 2×
 * DPR). Sources are now sized to roughly 2× their CSS box so the
 * file is right-sized without compromising sharpness on retina. */
/** Build a sized Unsplash URL from a base photo URL (no params). */
const sized = (base: string, w: number) =>
  `${base}?auto=format&fit=crop&q=85&w=${w}`;

type BookingSalonHeroProps = {
  shopLabel: string;
  /** `salons.logo_url`. Absent → the name alone identifies the salon. */
  logoUrl?: string | null;
  t: BookingMessages;
  className?: string;
  themeMode?: "dark" | "light";
  address?: string | null;
  openingHoursRaw?: unknown | null;
  timezone?: string;
  /** P2.8 — owner-written tagline override. Falls back to the
   * `salonHeroTagline` generic copy when null/empty. */
  description?: string | null;
  /** Vertical-specific fallback tagline, used when `description` is empty and
   *  before the generic i18n copy. Null for `nail_salon`. */
  fallbackTagline?: string | null;
  /** P2.2 — pick localized strings inside the info line below. */
  lang?: "vi" | "en";
  /** Per-vertical booking imagery (base Unsplash photo URLs). */
  imagery: { hero: string; thumbA: string; thumbB: string };
};

/**
 * Desktop-only glass panel: salon identity + decor imagery.
 * Hidden below `lg` so mobile / iPhone layout is unchanged.
 *
 * Light mode keeps the luxury feel of dark-photo + white salon name:
 * the photo overlay drops to ~30% so the image reads naturally, and
 * the name card switches to `rgba(0,0,0,0.4)` so white type stays
 * legible against the photo.
 */
export function BookingSalonHero({
  shopLabel,
  logoUrl,
  t,
  className,
  themeMode = "dark",
  address,
  openingHoursRaw,
  timezone,
  description,
  fallbackTagline,
  lang = "vi",
  imagery,
}: BookingSalonHeroProps) {
  const isLight = themeMode === "light";
  const HERO_BG = sized(imagery.hero, 1200);
  const HERO_BG_2X = sized(imagery.hero, 1600);
  const THUMB_A = sized(imagery.thumbA, 400);
  const THUMB_A_2X = sized(imagery.thumbA, 600);
  const THUMB_B = sized(imagery.thumbB, 400);
  const THUMB_B_2X = sized(imagery.thumbB, 600);

  const ambientGradient = isLight
    ? "linear-gradient(to bottom, color-mix(in srgb, var(--booking-bg) 20%, transparent), color-mix(in srgb, var(--booking-bg) 25%, transparent), color-mix(in srgb, var(--booking-bg) 30%, transparent))"
    : "linear-gradient(to bottom, color-mix(in srgb, var(--booking-bg) 55%, transparent), color-mix(in srgb, var(--booking-bg) 72%, transparent), color-mix(in srgb, var(--booking-bg) 95%, transparent))";

  const thumbVignette = isLight
    ? "linear-gradient(to top, color-mix(in srgb, var(--booking-bg) 20%, transparent), transparent)"
    : "linear-gradient(to top, color-mix(in srgb, var(--booking-bg) 55%, transparent), transparent)";

  const nameCardStyle = isLight
    ? { background: "rgba(0, 0, 0, 0.4)" }
    : undefined;

  return (
    <aside
      className={cn(
        "relative hidden min-h-[min(720px,calc(100dvh-5rem))] w-full flex-col overflow-hidden rounded-[1.75rem] border border-white/[0.08] shadow-[0_24px_80px_-28px_rgba(0,0,0,0.65)] lg:flex lg:max-w-[440px]",
        className,
      )}
      aria-label={t.salonHeroAriaLabel}
    >
      <div className="pointer-events-none absolute inset-0">
        {/* P2.6 — decorative; aria-hidden so AT skip it, lazy
            so the LCP-relevant content paints first.
            QA re-test #15 — srcset narrows the download to the
            actual rendered size on the user's display density. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={HERO_BG}
          srcSet={`${HERO_BG} 1x, ${HERO_BG_2X} 2x`}
          sizes="440px"
          alt=""
          aria-hidden="true"
          loading="lazy"
          className="h-full w-full scale-105 object-cover blur-[2px]"
        />
        <div
          className="absolute inset-0"
          style={{ background: ambientGradient }}
          aria-hidden
        />
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col justify-between gap-8 p-7 lg:p-8">
        <div
          className="nq-booking-glass-strong-panel rounded-[1.35rem] px-6 py-6"
          style={nameCardStyle}
        >
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={shopLabel}
              data-testid="salon-logo"
              className="mb-4 h-12 w-auto max-w-[180px] object-contain"
            />
          ) : null}
          <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-white/70">
            {t.salonHeroEyebrow}
          </p>
          <h2 className="mt-3 text-balance font-semibold tracking-tight text-white lg:text-3xl lg:leading-[1.15] lg:tracking-[-0.02em]">
            {shopLabel}
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-white/70 lg:text-base">
            {description?.trim() || fallbackTagline?.trim() || t.salonHeroTagline}
          </p>
          {timezone ? (
            <BookingSalonInfoLine
              address={address ?? null}
              openingHoursRaw={openingHoursRaw ?? null}
              timezone={timezone}
              variant="desktop"
              lang={lang}
            />
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-white/[0.08] shadow-lg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={THUMB_A}
              srcSet={`${THUMB_A} 1x, ${THUMB_A_2X} 2x`}
              sizes="210px"
              alt=""
              aria-hidden="true"
              loading="lazy"
              className="h-full w-full object-cover"
            />
            <div
              className="absolute inset-0"
              style={{ background: thumbVignette }}
              aria-hidden
            />
          </div>
          <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-white/[0.08] shadow-lg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={THUMB_B}
              srcSet={`${THUMB_B} 1x, ${THUMB_B_2X} 2x`}
              sizes="210px"
              alt=""
              aria-hidden="true"
              loading="lazy"
              className="h-full w-full object-cover"
            />
            <div
              className="absolute inset-0"
              style={{ background: thumbVignette }}
              aria-hidden
            />
          </div>
        </div>
      </div>
    </aside>
  );
}
