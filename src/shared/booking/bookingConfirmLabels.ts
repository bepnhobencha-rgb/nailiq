/** Guest-facing date/time label for the selected booking-surface language. */
export function formatBookingSlotDisplay(
  selectedDate: Date,
  timeSlotLabel: string,
  language: "en" | "vi" = "en",
): string {
  const datePart = selectedDate.toLocaleDateString(
    language === "vi" ? "vi-VN" : "en-US",
    {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    },
  );
  return `${datePart} · ${timeSlotLabel}`;
}

export function bookingDateYmdFromLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
