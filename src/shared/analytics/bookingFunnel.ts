export const ANALYTICS_CONSENT_STORAGE_KEY = "nailiq-analytics-consent-v1";
export const ANALYTICS_CONSENT_CHANGED_EVENT =
  "nailiq:analytics-consent-changed";

export type AnalyticsConsent = "granted" | "denied";
export type BookingAnalyticsFlow = "individual" | "group";
export type BookingFunnelStep =
  | "start"
  | "group_size_selected"
  | "service_selected"
  | "staff_selected"
  | "date_selected"
  | "time_selected"
  | "details_entered"
  | "arrangement_selected"
  | "confirmation_reached";

export type BookingAnalyticsEventName =
  | "booking_funnel_open"
  | "booking_funnel_progress"
  | "booking_submit_attempt"
  | "booking_complete"
  | "booking_failure"
  | "booking_abandon";

export type AnalyticsPageCategory =
  | "landing"
  | "marketing"
  | "account"
  | "public_booking"
  | "booking_status"
  | "dashboard"
  | "private_action"
  | "other";

type BookingAnalyticsEventParams = {
  booking_flow: BookingAnalyticsFlow;
  funnel_step?: BookingFunnelStep;
  failure_code?: "submit_rejected";
  transport_type?: "beacon";
};

type AnalyticsWindow = {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  [key: `ga-disable-${string}`]: boolean | undefined;
};

const GA_MEASUREMENT_ID = /^G-[A-Z0-9]+$/;
const BOOKING_EVENT_NAMES = new Set<BookingAnalyticsEventName>([
  "booking_funnel_open",
  "booking_funnel_progress",
  "booking_submit_attempt",
  "booking_complete",
  "booking_failure",
  "booking_abandon",
]);
const BOOKING_FLOWS = new Set<BookingAnalyticsFlow>(["individual", "group"]);
const BOOKING_FUNNEL_STEPS = new Set<BookingFunnelStep>([
  "start",
  "group_size_selected",
  "service_selected",
  "staff_selected",
  "date_selected",
  "time_selected",
  "details_entered",
  "arrangement_selected",
  "confirmation_reached",
]);

export function resolveGoogleAnalyticsId(
  raw: string | null | undefined,
): string | null {
  const normalized = raw?.trim().toUpperCase() ?? "";
  return GA_MEASUREMENT_ID.test(normalized) ? normalized : null;
}

export function parseAnalyticsConsent(value: string | null): AnalyticsConsent | null {
  return value === "granted" || value === "denied" ? value : null;
}

export function readAnalyticsConsent(
  storage: Pick<Storage, "getItem"> | null =
    typeof window === "undefined" ? null : window.localStorage,
): AnalyticsConsent | null {
  if (!storage) return null;
  try {
    return parseAnalyticsConsent(storage.getItem(ANALYTICS_CONSENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeAnalyticsConsent(
  consent: AnalyticsConsent,
  storage: Pick<Storage, "setItem"> | null =
    typeof window === "undefined" ? null : window.localStorage,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, consent);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(ANALYTICS_CONSENT_CHANGED_EVENT, { detail: consent }),
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function setGoogleAnalyticsDisabled(
  measurementId: string,
  disabled: boolean,
): void {
  if (typeof window === "undefined") return;
  const analyticsWindow = window as unknown as AnalyticsWindow;
  analyticsWindow[`ga-disable-${measurementId}`] = disabled;
}

/**
 * Sends a deliberately small, runtime-allowlisted booking event.
 *
 * The parameter type has no slot for names, phones, emails, notes, salon ids,
 * URLs, or arbitrary strings. The runtime copy below also strips unknown keys
 * passed from untyped JavaScript before they can reach Google Analytics.
 */
export function trackBookingAnalyticsEvent(
  name: BookingAnalyticsEventName,
  params: BookingAnalyticsEventParams,
): boolean {
  if (typeof window === "undefined" || readAnalyticsConsent() !== "granted") {
    return false;
  }
  if (!BOOKING_EVENT_NAMES.has(name) || !BOOKING_FLOWS.has(params.booking_flow)) {
    return false;
  }

  const safeParams: BookingAnalyticsEventParams = {
    booking_flow: params.booking_flow,
  };
  if (params.funnel_step && BOOKING_FUNNEL_STEPS.has(params.funnel_step)) {
    safeParams.funnel_step = params.funnel_step;
  }
  if (params.failure_code === "submit_rejected") {
    safeParams.failure_code = params.failure_code;
  }
  if (params.transport_type === "beacon") {
    safeParams.transport_type = params.transport_type;
  }

  const analyticsWindow = window as unknown as AnalyticsWindow;
  analyticsWindow.dataLayer ??= [];
  analyticsWindow.gtag ??= (...args: unknown[]) => {
    analyticsWindow.dataLayer?.push(args);
  };
  analyticsWindow.gtag("event", name, safeParams);
  return true;
}

export function analyticsPageCategory(pathname: string): AnalyticsPageCategory {
  if (pathname === "/") return "landing";
  if (/^\/(privacy|terms|contact|pricing)(?:\/|$)/.test(pathname)) {
    return "marketing";
  }
  if (/^\/(login|register|auth)(?:\/|$)/.test(pathname)) return "account";
  if (/^\/dashboard(?:\/|$)/.test(pathname)) return "dashboard";
  if (/^\/(wait|status)(?:\/|$)/.test(pathname)) return "booking_status";
  if (/^\/(party|offer|v|manage)(?:\/|$)/.test(pathname)) return "private_action";
  if (/^\/[^/]+\/?$/.test(pathname)) return "public_booking";
  return "other";
}

export function trackAnalyticsPageView(category: AnalyticsPageCategory): boolean {
  if (typeof window === "undefined" || readAnalyticsConsent() !== "granted") {
    return false;
  }
  const analyticsWindow = window as unknown as AnalyticsWindow;
  analyticsWindow.dataLayer ??= [];
  analyticsWindow.gtag ??= (...args: unknown[]) => {
    analyticsWindow.dataLayer?.push(args);
  };
  analyticsWindow.gtag("event", "page_view", {
    page_category: category,
    page_title: category,
    page_location: window.location.origin,
  });
  return true;
}

export function bookingStepMilestone(
  flow: BookingAnalyticsFlow,
  step: string | number,
): { name: BookingAnalyticsEventName; funnelStep?: BookingFunnelStep } | null {
  if (flow === "individual") {
    switch (step) {
      case "phone":
      case "service":
        return { name: "booking_funnel_open", funnelStep: "start" };
      case "staff":
        return { name: "booking_funnel_progress", funnelStep: "service_selected" };
      case "date":
        return { name: "booking_funnel_progress", funnelStep: "staff_selected" };
      case "time":
        return { name: "booking_funnel_progress", funnelStep: "date_selected" };
      case "info":
        return { name: "booking_funnel_progress", funnelStep: "time_selected" };
      case "verify":
      case "otp":
      case "deposit":
        return { name: "booking_funnel_progress", funnelStep: "details_entered" };
      case "confirm":
        return {
          name: "booking_funnel_progress",
          funnelStep: "confirmation_reached",
        };
      case "done":
        return { name: "booking_complete" };
      default:
        return null;
    }
  }

  switch (step) {
    case 1:
      return { name: "booking_funnel_open", funnelStep: "start" };
    case 2:
      return {
        name: "booking_funnel_progress",
        funnelStep: "group_size_selected",
      };
    case 3:
      return { name: "booking_funnel_progress", funnelStep: "service_selected" };
    case 4:
      return { name: "booking_funnel_progress", funnelStep: "time_selected" };
    case 5:
      return {
        name: "booking_funnel_progress",
        funnelStep: "arrangement_selected",
      };
    case "success":
      return { name: "booking_complete" };
    default:
      return null;
  }
}
