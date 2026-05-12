import type { BookingMessages } from "@/shared/i18n/booking/en";
import { BookingSalonInfoLine } from "./BookingSalonInfoLine";

/**
 * Mobile-only salon identity banner. Mirrors the eyebrow + name + tagline
 * triad from BookingSalonHero (desktop sidebar) so guests on a phone still
 * see the salon they're booking, not just the generic "Book this salon".
 *
 * Hidden from `lg:` up where BookingSalonHero takes over.
 *
 * Light mode: salon-primary tinted gradient over a light page can wash
 * the white salon-name text out, so a `bg-black/40` backdrop is added
 * to preserve the luxury dark-card feel and keep the white type legible.
 */
export function BookingMobileHero({
  shopLabel,
  t,
  themeMode = "dark",
  address,
  openingHoursRaw,
  timezone,
}: {
  shopLabel: string;
  t: BookingMessages;
  themeMode?: "dark" | "light";
  address?: string | null;
  openingHoursRaw?: unknown | null;
  timezone?: string;
}) {
  const isLight = themeMode === "light";
  return (
    <section
      aria-label={t.salonHeroAriaLabel}
      className="lg:hidden relative overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--salon-primary)_25%,transparent)] bg-gradient-to-br from-[color-mix(in_srgb,var(--salon-primary)_12%,transparent)] via-[color-mix(in_srgb,var(--salon-primary)_4%,transparent)] to-transparent px-5 py-5 sm:px-6 sm:py-6"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -top-12 -right-10 h-32 w-32 rounded-full bg-[color-mix(in_srgb,var(--salon-primary)_15%,transparent)] blur-3xl"
      />
      {isLight ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-black/40"
        />
      ) : null}
      <p className="relative text-[10px] font-medium uppercase tracking-[0.28em] text-white/70">
        {t.salonHeroEyebrow}
      </p>
      <h1 className="relative mt-2 text-balance text-2xl font-semibold tracking-tight text-white sm:text-3xl">
        {shopLabel}
      </h1>
      <p className="relative mt-2 text-sm leading-relaxed text-white/70">
        {t.salonHeroTagline}
      </p>
      {timezone ? (
        <div className="relative text-white/85">
          <BookingSalonInfoLine
            address={address ?? null}
            openingHoursRaw={openingHoursRaw ?? null}
            timezone={timezone}
            variant="mobile"
          />
        </div>
      ) : null}
    </section>
  );
}
