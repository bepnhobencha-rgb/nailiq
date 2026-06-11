/**
 * Owner/admin booking-notification settings (pure, framework-free).
 *
 * Stored as JSONB on `salons.owner_notification_settings`. Null / malformed →
 * disabled defaults, so a salon that never configured it stays silent.
 */

export type OwnerNotificationEvent =
  | "new"
  | "reschedule"
  | "cancel"
  | "no_show";

export const OWNER_NOTIFICATION_EVENTS: OwnerNotificationEvent[] = [
  "new",
  "reschedule",
  "cancel",
  "no_show",
];

export type OwnerNotificationSettings = {
  /** Master switch. When false nothing is sent regardless of event flags. */
  enabled: boolean;
  /** Email every owner + admin salon_member (their account email). */
  notifyMembers: boolean;
  /** Extra recipient emails (lowercased, de-duped, validated). */
  customEmails: string[];
  /** Which booking events trigger an email. */
  events: Record<OwnerNotificationEvent, boolean>;
};

export const DEFAULT_OWNER_NOTIFICATION_SETTINGS: OwnerNotificationSettings = {
  enabled: false,
  notifyMembers: true,
  customEmails: [],
  events: { new: true, reschedule: true, cancel: true, no_show: false },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CUSTOM_EMAILS = 10;

/** Normalize a free-text email list into validated, lowercased, unique entries. */
export function normalizeCustomEmails(input: unknown): string[] {
  const raw: string[] = Array.isArray(input)
    ? input.map((x) => String(x))
    : typeof input === "string"
      ? input.split(/[\s,;]+/)
      : [];
  const out: string[] = [];
  for (const r of raw) {
    const e = r.trim().toLowerCase();
    if (!e) continue;
    if (e.length > 254 || !EMAIL_RE.test(e)) continue;
    if (!out.includes(e)) out.push(e);
    if (out.length >= MAX_CUSTOM_EMAILS) break;
  }
  return out;
}

/** Parse the raw JSONB column into a complete, safe settings object. */
export function parseOwnerNotificationSettings(
  raw: unknown,
): OwnerNotificationSettings {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_OWNER_NOTIFICATION_SETTINGS };
  }
  const o = raw as Record<string, unknown>;
  const evIn =
    o.events && typeof o.events === "object"
      ? (o.events as Record<string, unknown>)
      : {};
  const events = {} as Record<OwnerNotificationEvent, boolean>;
  for (const ev of OWNER_NOTIFICATION_EVENTS) {
    events[ev] =
      typeof evIn[ev] === "boolean"
        ? (evIn[ev] as boolean)
        : DEFAULT_OWNER_NOTIFICATION_SETTINGS.events[ev];
  }
  return {
    enabled: o.enabled === true,
    notifyMembers: o.notifyMembers !== false, // default true
    customEmails: normalizeCustomEmails(o.customEmails),
    events,
  };
}

/** True when this settings + event should produce an email. */
export function shouldNotify(
  settings: OwnerNotificationSettings,
  event: OwnerNotificationEvent,
): boolean {
  return settings.enabled && settings.events[event] === true;
}
