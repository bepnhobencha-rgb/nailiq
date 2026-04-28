export function formatNailiqBookingRef(id: string): string {
  const compact = id.replace(/-/g, "");
  return `#NQ-${compact.slice(0, 8)}`;
}
