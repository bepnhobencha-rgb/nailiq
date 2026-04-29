"use client";

import { useEffect, useState } from "react";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { loadSavedBookingGuestProfile } from "@/shared/booking/bookingClientProfile";

/**
 * WOW layer (light): returning guest greeting from saved device profile.
 */
export function BookingReturningGreeting({ t }: { t: BookingMessages }) {
  const [line, setLine] = useState<string | null>(null);

  useEffect(() => {
    const p = loadSavedBookingGuestProfile();
    if (!p?.name?.trim()) return;
    const first = p.name.trim().split(/\s+/)[0] ?? "";
    if (!first) return;
    setLine(t.returningGreeting.replace("{name}", first));
  }, [t.returningGreeting]);

  if (!line) return null;

  return (
    <p className="mt-2 text-sm font-medium text-nq-primary lg:text-[15px]">{line}</p>
  );
}
