import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookingFlowTimePanel } from "../BookingFlowTimePanel";
import { bookingEn } from "@/shared/i18n/booking/en";
import { bookingVi } from "@/shared/i18n/booking/vi";

describe("unverified capacity is neither open nor a full day", () => {
  it.each([bookingEn, bookingVi])("blocks stale choices and waitlist with a localized error", t => {
    const noop = () => {};
    const html = renderToStaticMarkup(createElement(BookingFlowTimePanel, {
      t, timeSlots: [{label: "2:00 PM", available: true}], timeSlot: "2:00 PM",
      slotsLoading: false, availabilityUnverified: true,
      availabilityRealtimeStatus: "degraded", timezoneAbbr: "PDT", stepDir: 1,
      reducedMotion: true, stepTransition: {duration: 0, ease: [0, 0, 1, 1]},
      clientName: "QA Guest", clientPhone: "", clientEmail: "",
      waitlistSubmitting: false, waitlistSlotJoined: false,
      waitlistSlotAvailableLabel: null, waitlistPreferredTime: "", waitlistTimeOptions: [],
      waitlistContactInvalid: true, scarcityHint: null, error: null,
      onClientNameChange: noop, onClientPhoneChange: noop, onClientEmailChange: noop,
      onWaitlistPreferredTimeChange: noop, onWaitlistSubmit: noop, onSelectSlot: noop,
      onBack: noop, onNext: noop,
    }));
    expect(html).toContain('data-testid="booking-availability-unverified"');
    expect(html).toContain(t.availabilityGridUnverified.replaceAll("'", "&#x27;"));
    expect(html).not.toContain('data-testid="time-slot"');
    expect(html).not.toContain(t.noSlotsAvailable);
    expect(html).not.toContain(t.waitlistNotifyCta);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?<\/button>/);
  });
});
