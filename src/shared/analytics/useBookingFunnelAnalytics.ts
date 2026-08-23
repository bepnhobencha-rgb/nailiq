"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  ANALYTICS_CONSENT_CHANGED_EVENT,
  bookingStepMilestone,
  trackBookingAnalyticsEvent,
  type BookingAnalyticsFlow,
} from "@/shared/analytics/bookingFunnel";

type BookingFunnelAnalyticsOptions = {
  flow: BookingAnalyticsFlow;
  step: string | number;
  submitting: boolean;
  hasError: boolean;
};

export function useBookingFunnelAnalytics({
  flow,
  step,
  submitting,
  hasError,
}: BookingFunnelAnalyticsOptions): void {
  const seenRef = useRef(new Set<string>());
  const stepRef = useRef(step);
  const previousSubmittingRef = useRef(false);

  const recordCurrentStep = useCallback(() => {
    const current = bookingStepMilestone(flow, stepRef.current);
    if (!current) return;

    const openKey = "booking_funnel_open:start";
    if (!seenRef.current.has(openKey)) {
      const sent = trackBookingAnalyticsEvent("booking_funnel_open", {
        booking_flow: flow,
        funnel_step: "start",
      });
      if (sent) seenRef.current.add(openKey);
    }

    const currentKey = `${current.name}:${current.funnelStep ?? "complete"}`;
    if (currentKey === openKey || seenRef.current.has(currentKey)) return;
    const sent = trackBookingAnalyticsEvent(current.name, {
      booking_flow: flow,
      ...(current.funnelStep ? { funnel_step: current.funnelStep } : {}),
    });
    if (sent) seenRef.current.add(currentKey);
  }, [flow]);

  useEffect(() => {
    const previous = bookingStepMilestone(flow, stepRef.current);
    const current = bookingStepMilestone(flow, step);
    if (
      previous?.name === "booking_complete" &&
      current?.name !== "booking_complete"
    ) {
      seenRef.current.clear();
    }
    stepRef.current = step;
    recordCurrentStep();
  }, [flow, recordCurrentStep, step]);

  useEffect(() => {
    const onConsentChanged = () => recordCurrentStep();
    window.addEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, onConsentChanged);
    return () =>
      window.removeEventListener(ANALYTICS_CONSENT_CHANGED_EVENT, onConsentChanged);
  }, [recordCurrentStep]);

  useEffect(() => {
    if (submitting && !previousSubmittingRef.current) {
      trackBookingAnalyticsEvent("booking_submit_attempt", {
        booking_flow: flow,
      });
    } else if (!submitting && previousSubmittingRef.current && hasError) {
      trackBookingAnalyticsEvent("booking_failure", {
        booking_flow: flow,
        failure_code: "submit_rejected",
      });
    }
    previousSubmittingRef.current = submitting;
  }, [flow, hasError, submitting]);

  useEffect(() => {
    const onPageHide = () => {
      const current = bookingStepMilestone(flow, stepRef.current);
      if (!current || current.name === "booking_complete") return;
      trackBookingAnalyticsEvent("booking_abandon", {
        booking_flow: flow,
        funnel_step: current.funnelStep ?? "start",
        transport_type: "beacon",
      });
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [flow]);
}
