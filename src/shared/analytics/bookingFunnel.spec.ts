import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_CONSENT_STORAGE_KEY,
  analyticsPageCategory,
  bookingStepMilestone,
  parseAnalyticsConsent,
  readAnalyticsConsent,
  resolveGoogleAnalyticsId,
  trackBookingAnalyticsEvent,
  writeAnalyticsConsent,
} from "@/shared/analytics/bookingFunnel";

describe("privacy-safe booking analytics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts only valid GA4 measurement ids", () => {
    expect(resolveGoogleAnalyticsId(" g-ab12cd34 ")).toBe("G-AB12CD34");
    expect(resolveGoogleAnalyticsId("UA-1234")).toBeNull();
    expect(resolveGoogleAnalyticsId("G-ABC<script>")).toBeNull();
    expect(resolveGoogleAnalyticsId(undefined)).toBeNull();
  });

  it("fails closed for missing, corrupt, or unavailable consent storage", () => {
    expect(parseAnalyticsConsent(null)).toBeNull();
    expect(parseAnalyticsConsent("yes")).toBeNull();
    expect(readAnalyticsConsent({ getItem: () => "denied" })).toBe("denied");
    expect(
      readAnalyticsConsent({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBeNull();
  });

  it("persists only the explicit consent choice", () => {
    const setItem = vi.fn();
    expect(writeAnalyticsConsent("granted", { setItem })).toBe(true);
    expect(setItem).toHaveBeenCalledWith(
      ANALYTICS_CONSENT_STORAGE_KEY,
      "granted",
    );
  });

  it("does not dispatch before opt-in", () => {
    const gtag = vi.fn();
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "denied" },
      gtag,
    });
    expect(
      trackBookingAnalyticsEvent("booking_funnel_open", {
        booking_flow: "individual",
        funnel_step: "start",
      }),
    ).toBe(false);
    expect(gtag).not.toHaveBeenCalled();
  });

  it("strips unknown fields at runtime before dispatch", () => {
    const gtag = vi.fn();
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "granted" },
      dataLayer: [],
      gtag,
    });
    const unsafe = {
      booking_flow: "individual",
      funnel_step: "time_selected",
      email: "guest@example.com",
      salon_id: "private-tenant-id",
    } as never;
    expect(trackBookingAnalyticsEvent("booking_funnel_progress", unsafe)).toBe(
      true,
    );
    expect(gtag).toHaveBeenCalledWith("event", "booking_funnel_progress", {
      booking_flow: "individual",
      funnel_step: "time_selected",
    });
  });

  it("maps individual and group milestones without identity data", () => {
    expect(bookingStepMilestone("individual", "staff")).toEqual({
      name: "booking_funnel_progress",
      funnelStep: "service_selected",
    });
    expect(bookingStepMilestone("individual", "done")).toEqual({
      name: "booking_complete",
    });
    expect(bookingStepMilestone("group", 5)).toEqual({
      name: "booking_funnel_progress",
      funnelStep: "arrangement_selected",
    });
    expect(bookingStepMilestone("group", 2)).toEqual({
      name: "booking_funnel_progress",
      funnelStep: "group_size_selected",
    });
    expect(bookingStepMilestone("group", "success")).toEqual({
      name: "booking_complete",
    });
  });

  it("buckets routes without sending raw paths or tenant slugs", () => {
    expect(analyticsPageCategory("/")).toBe("landing");
    expect(analyticsPageCategory("/hilite-studio")).toBe("public_booking");
    expect(analyticsPageCategory("/dashboard/hilite-studio/center")).toBe(
      "dashboard",
    );
    expect(analyticsPageCategory("/party/private-token")).toBe("private_action");
  });
});
