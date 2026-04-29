/** Full English guest-facing label for confirm/done (booking route is English-only). */
export function formatBookingSlotDisplay(
  selectedDate: Date,
  timeSlotLabel: string,
): string {
  const datePart = selectedDate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${datePart} · ${timeSlotLabel}`;
}

export function bookingDateYmdFromLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
