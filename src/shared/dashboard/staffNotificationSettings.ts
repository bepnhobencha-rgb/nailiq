/**
 * Staff-action CUSTOMER notification settings (pure, framework-free).
 *
 * Controls what happens when a STAFF member creates / reschedules / cancels /
 * no-shows a booking from the dashboard: which channels are offered, the
 * default language, and whether the "notify the customer" toggle starts ON for
 * each event (the "smart per-event" defaults Huy chose — cancel + reschedule
 * ON, no-show OFF).
 *
 * Stored as JSONB on `salons.staff_notification_settings`. Null / malformed →
 * the DEFAULT below (panel enabled, English default, SMS+Email offered).
 *
 * NOTE: this only governs STAFF-initiated actions. Online self-booking keeps
 * its own confirmation flow + the customer's chosen site language
 * (`bookings.client_locale`), resolved via `resolveCustomerLocale`.
 */

import type { SupportedLocale } from "@/shared/notifications/resolveCustomerLocale";
import { DEFAULT_CUSTOMER_LOCALE } from "@/shared/notifications/resolveCustomerLocale";

export type StaffNotifyEvent =
  "create" | "reschedule" | "cancel" | "no_show" | "staff_change";

export const STAFF_NOTIFY_EVENTS: StaffNotifyEvent[] = [
  "create",
  "reschedule",
  "cancel",
  "no_show",
  "staff_change",
];

export type StaffNotifyChannel = "sms" | "email";

export type StaffNotificationChannelAvailability = Record<
  StaffNotifyChannel,
  boolean
>;

export type StaffNotificationSettings = {
  /** Master switch. When false the notify panel never appears and staff
   *  actions stay silent (legacy behavior). */
  enabled: boolean;
  /** Per-salon default language for staff-initiated messages. Online bookings
   *  still override this with the customer's captured site language. */
  defaultLocale: SupportedLocale;
  /** Which channels the notify panel offers (a channel is also hidden at
   *  runtime when the booking has no phone / email on file). */
  channels: Record<StaffNotifyChannel, boolean>;
  /** Smart per-event default: does the "notify customer" toggle start ON? */
  eventDefaults: Record<StaffNotifyEvent, boolean>;
};

export const DEFAULT_STAFF_NOTIFICATION_SETTINGS: StaffNotificationSettings = {
  enabled: true,
  defaultLocale: DEFAULT_CUSTOMER_LOCALE, // "en"
  channels: { sms: true, email: true },
  // Cancel + reschedule: the customer NEEDS to know → ON. Create: confirm the
  // desk booking → ON. No-show: rarely worth a ping → OFF.
  eventDefaults: {
    create: true,
    reschedule: true,
    cancel: true,
    no_show: false,
    staff_change: true,
  },
};

function normLocale(v: unknown): SupportedLocale {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "vi" ? "vi" : "en";
}

/** Parse the raw JSONB column into a complete, safe settings object. */
export function parseStaffNotificationSettings(
  raw: unknown,
  fallbackLocale: SupportedLocale = DEFAULT_CUSTOMER_LOCALE,
): StaffNotificationSettings {
  if (!raw || typeof raw !== "object") {
    return {
      ...structuredCloneSettings(DEFAULT_STAFF_NOTIFICATION_SETTINGS),
      defaultLocale: fallbackLocale,
    };
  }
  const o = raw as Record<string, unknown>;

  const chIn =
    o.channels && typeof o.channels === "object"
      ? (o.channels as Record<string, unknown>)
      : {};
  const channels: Record<StaffNotifyChannel, boolean> = {
    sms:
      typeof chIn.sms === "boolean"
        ? chIn.sms
        : DEFAULT_STAFF_NOTIFICATION_SETTINGS.channels.sms,
    email:
      typeof chIn.email === "boolean"
        ? chIn.email
        : DEFAULT_STAFF_NOTIFICATION_SETTINGS.channels.email,
  };

  const evIn =
    o.eventDefaults && typeof o.eventDefaults === "object"
      ? (o.eventDefaults as Record<string, unknown>)
      : {};
  const eventDefaults = {} as Record<StaffNotifyEvent, boolean>;
  for (const ev of STAFF_NOTIFY_EVENTS) {
    eventDefaults[ev] =
      typeof evIn[ev] === "boolean"
        ? (evIn[ev] as boolean)
        : DEFAULT_STAFF_NOTIFICATION_SETTINGS.eventDefaults[ev];
  }

  return {
    enabled: o.enabled !== false, // default true
    defaultLocale: o.defaultLocale
      ? normLocale(o.defaultLocale)
      : fallbackLocale,
    channels,
    eventDefaults,
  };
}

/** Whether the notify toggle should start ON for an event (false if the whole
 *  feature is disabled for the salon). */
export function defaultNotifyOn(
  settings: StaffNotificationSettings,
  event: StaffNotifyEvent,
): boolean {
  return settings.enabled && settings.eventDefaults[event] === true;
}

/** Resolve what the receptionist may actually offer. Stored preferences alone
 * are not delivery capability: the salon-wide outbound switch remains the
 * authoritative operational gate used by the notification worker. */
export function resolveStaffNotificationChannelAvailability(
  settings: StaffNotificationSettings,
  outbound: StaffNotificationChannelAvailability,
): StaffNotificationChannelAvailability {
  return {
    sms: settings.enabled && settings.channels.sms && outbound.sms,
    email: settings.enabled && settings.channels.email && outbound.email,
  };
}

function structuredCloneSettings(
  s: StaffNotificationSettings,
): StaffNotificationSettings {
  return {
    enabled: s.enabled,
    defaultLocale: s.defaultLocale,
    channels: { ...s.channels },
    eventDefaults: { ...s.eventDefaults },
  };
}
