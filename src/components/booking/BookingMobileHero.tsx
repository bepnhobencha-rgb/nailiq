import type { BookingMessages } from "@/shared/i18n/booking/en";

/**
 * Mobile-only salon identity banner. Mirrors the eyebrow + name + tagline
 * triad from BookingSalonHero (desktop sidebar) so guests on a phone still
 * see the salon they're booking, not just the generic "Book this salon".
 *
 * Hidden from `lg:` up where BookingSalonHero takes over.
 */
export function BookingMobileHero({
  shopLabel,
  t,
}: {
  shopLabel: string;
  t: BookingMessages;
}) {
  return (
    <section
      aria-label={t.salonHeroAriaLabel}
      className="lg:hidden relative overflow-hidden rounded-2xl border border-nq-primary/25 bg-gradient-to-br from-nq-primary/12 via-nq-primary/[0.04] to-transparent px-5 py-5 sm:px-6 sm:py-6"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -top-12 -right-10 h-32 w-32 rounded-full bg-nq-primary/15 blur-3xl"
      />
      <p className="relative text-[10px] font-medium uppercase tracking-[0.28em] text-nq-muted">
        {t.salonHeroEyebrow}
      </p>
      <h1 className="relative mt-2 text-balance text-2xl font-semibold tracking-tight text-nq-foreground sm:text-3xl">
        {shopLabel}
      </h1>
      <p className="relative mt-2 text-sm leading-relaxed text-nq-muted">
        {t.salonHeroTagline}
      </p>
    </section>
  );
}
