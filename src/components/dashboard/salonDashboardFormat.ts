import { getUserMessages } from "@/shared/i18n/user";
import type { BookingStatus } from "@/shared/types";

export function nextBookingStatus(
  current: BookingStatus,
): BookingStatus | null {
  if (current === "pending") return "confirmed";
  if (current === "confirmed") return "completed";
  return null;
}

export function salonBookingStatusLabel(
  s: BookingStatus,
  t: ReturnType<typeof getUserMessages>["salonDashboard"],
): string {
  if (s === "pending") return t.statusPending;
  if (s === "confirmed") return t.statusConfirmed;
  return t.statusCompleted;
}

export function salonBookingStatusClass(s: BookingStatus): string {
  if (s === "pending") {
    return "border-nq-primary/35 bg-nq-primary/10 text-nq-primary ring-1 ring-nq-primary/25";
  }
  if (s === "confirmed") {
    return "border-nq-info/35 bg-nq-info/10 text-nq-info ring-1 ring-nq-info/25";
  }
  return "border-nq-success/35 bg-nq-success/10 text-nq-success ring-1 ring-nq-success/25";
}

export function formatSalonMoney(cents: number, lang: "en" | "vi"): string {
  const amount = cents / 100;
  return new Intl.NumberFormat(lang === "vi" ? "vi-VN" : "en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}
