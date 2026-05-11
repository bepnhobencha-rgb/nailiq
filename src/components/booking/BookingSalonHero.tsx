import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";

/** Curated high-res salon imagery (Unsplash); used only on `lg:` and up. */
const HERO_BG =
  "https://images.unsplash.com/photo-1610992015732-2449b76344bc?auto=format&fit=crop&q=85&w=1600";
const THUMB_A =
  "https://images.unsplash.com/photo-1604654894610-df63bc536371?auto=format&fit=crop&q=85&w=800";
const THUMB_B =
  "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&q=85&w=800";

type BookingSalonHeroProps = {
  shopLabel: string;
  t: BookingMessages;
  className?: string;
  themeMode?: "dark" | "light";
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
  t,
  className,
  themeMode = "dark",
}: BookingSalonHeroProps) {
  const isLight = themeMode === "light";

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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={HERO_BG}
          alt=""
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
          <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-white/70">
            {t.salonHeroEyebrow}
          </p>
          <h2 className="mt-3 text-balance font-semibold tracking-tight text-white lg:text-3xl lg:leading-[1.15] lg:tracking-[-0.02em]">
            {shopLabel}
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-white/70 lg:text-base">
            {t.salonHeroTagline}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-white/[0.08] shadow-lg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={THUMB_A}
              alt=""
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
              alt=""
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
