export function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function formatBookingManagementTime(value: string, salonTimeZone: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !isValidIanaTimeZone(salonTimeZone)) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: salonTimeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
}
