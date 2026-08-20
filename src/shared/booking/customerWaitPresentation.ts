import { formatInSalonTz } from "@/shared/lib/salonTime";

export type CustomerBookingKind = "walkin" | "appointment";

export type CustomerBookingStatus =
  | "waiting"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

export type CustomerWaitSurface =
  | "appointment"
  | "waiting"
  | "ready"
  | "done"
  | "cancelled";

export function customerBookingKindFromSource(
  source: string | null | undefined,
): CustomerBookingKind {
  return String(source ?? "").trim().toLowerCase() === "walkin"
    ? "walkin"
    : "appointment";
}

export function resolveCustomerWaitSurface(
  kind: CustomerBookingKind,
  status: CustomerBookingStatus,
): CustomerWaitSurface {
  if (status === "cancelled" || status === "no_show") return "cancelled";
  if (status === "completed") return "done";
  if (status === "in_progress") return "ready";
  if (kind === "appointment" && status === "confirmed") {
    return "appointment";
  }
  return "waiting";
}

/** Keep the SSR and browser clock text identical by using the salon timezone. */
export function formatCustomerWaitReadyClock(
  readyAroundIso: string,
  timezone: string,
): string {
  return formatInSalonTz(readyAroundIso, timezone, "time");
}

/**
 * Format a scheduled appointment without relying on the runtime's localized
 * punctuation, spacing, day-period text, or timezone abbreviation.
 *
 * Node (Vercel) and WebKit (notably iOS Safari) can ship different ICU/CLDR
 * versions. Calling `Intl.DateTimeFormat(...).format()` during SSR and again
 * during hydration can therefore produce visually equivalent but byte-wise
 * different text (for example `at` vs a comma, NBSP vs a normal space, or
 * `PDT` vs `GMT-7`). React treats that as a text mismatch and reports #418.
 *
 * We still use Intl to perform the timezone conversion, but read only numeric
 * parts and assemble the customer-facing string ourselves. That makes the
 * server and browser output deterministic while preserving salon-local time.
 */
export function formatCustomerAppointmentDateTime(
  startTimeUtc: string,
  timezone: string,
  language: "en" | "vi",
): string {
  const instant = new Date(startTimeUtc);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`customerWait: invalid appointment time ${startTimeUtc}`);
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  const year = Number(value("year"));
  const month = Number(value("month"));
  const day = Number(value("day"));
  const hour24 = Number(value("hour"));
  const minute = Number(value("minute"));
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour24) ||
    !Number.isInteger(minute)
  ) {
    throw new Error("customerWait: could not format appointment time");
  }

  // The date parts above are already in salon time. UTC here is intentional:
  // it derives the weekday from that wall-calendar date without applying the
  // machine's own timezone a second time.
  const weekdayIndex = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  if (language === "vi") {
    const weekdays = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"] as const;
    return `${weekdays[weekdayIndex]}, ${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year} · ${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ] as const;
  const hour12 = hour24 % 12 || 12;
  const dayPeriod = hour24 < 12 ? "AM" : "PM";
  return `${weekdays[weekdayIndex]}, ${months[month - 1]} ${day}, ${year} · ${hour12}:${String(minute).padStart(2, "0")} ${dayPeriod}`;
}
