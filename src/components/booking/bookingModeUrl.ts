export type BookingMode = "individual" | "sequence" | "group";

/**
 * Return the URL needed to reflect a booking-mode change, or null when the
 * current URL already represents that mode. Keeping the no-op explicit avoids
 * an App Router replace loop that repeatedly requests the same RSC payload.
 */
export function bookingModeHref(
  pathname: string,
  currentSearch: string,
  mode: BookingMode,
): string | null {
  const next = new URLSearchParams(currentSearch);
  if (mode === "group" || mode === "sequence") next.set("mode", mode);
  else next.delete("mode");

  const nextSearch = next.toString();
  if (nextSearch === currentSearch) return null;
  return nextSearch ? `${pathname}?${nextSearch}` : pathname;
}
