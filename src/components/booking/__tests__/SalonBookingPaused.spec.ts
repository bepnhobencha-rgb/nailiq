import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SalonBookingPaused } from "../SalonBookingPaused";
import type { BookingMessages } from "@/shared/i18n/booking/en";

describe("SalonBookingPaused", () => {
  it("uses the active booking theme text colors", () => {
    const t = {
      salonNotLiveHeading: "Booking paused",
      salonNotLiveBody: "{shop} is not accepting bookings.",
    } as BookingMessages;

    const html = renderToStaticMarkup(
      createElement(SalonBookingPaused, { shopLabel: "QA Salon", t }),
    );

    expect(html).toContain("text-[var(--booking-text)]");
    expect(html).toContain("text-[var(--booking-text-muted)]");
    expect(html).not.toContain("text-nq-foreground");
    expect(html).not.toContain("text-nq-muted");
  });
});
