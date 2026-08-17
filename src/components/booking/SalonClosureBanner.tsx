/**
 * Bilingual closure notice on the public booking page (e.g. "closed for
 * renovation"). Both languages render together — matches the pattern used by
 * SubscriptionDeadlineNotice, since the visitor's language-toggle state may
 * not match who actually needs to read this. Self-expiring: the caller only
 * renders this once `hasUpcomingClosure` confirms a listed closed date is
 * still today or later, so nothing needs manual cleanup once the closure
 * period passes.
 */
export function SalonClosureBanner({ notice }: { notice: { en: string; vi: string } }) {
  return (
    <div
      role="status"
      className="mb-5 rounded-2xl border border-amber-400/45 bg-amber-400/10 px-4 py-3"
    >
      <p className="text-sm font-semibold leading-snug text-[var(--booking-text)]">
        {notice.en}
      </p>
      <p className="mt-1 text-sm leading-snug text-[var(--booking-text-muted)]">
        {notice.vi}
      </p>
    </div>
  );
}
