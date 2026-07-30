const CREATED_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * Salon creation timestamps are stored in UTC. Pinning the display timezone
 * keeps the Server Component HTML and Client Component hydration deterministic.
 */
export function formatSalonCreatedDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return CREATED_FORMATTER.format(date);
}
