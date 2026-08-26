import "server-only";

import { canonicalizeStrictRfc3339Instant } from "@/shared/lib/strictRfc3339Instant";
import {
  buildEmailBrandHeader,
  escapeEmailHtml,
} from "@/shared/booking/emailBranding";
import {
  complianceFooterHtml,
  listUnsubscribeHeaders,
} from "@/shared/lib/emailCompliance";
import { getResendFrom } from "@/shared/lib/resend";
import {
  buildStaffActionEmailSubject,
  buildStaffActionSms,
} from "@/shared/notifications/staffActionMessages";
import {
  serializeStaffActionNotificationEnvelope,
  type StaffActionNotificationEnvelope,
  type StaffActionNotificationEvent,
} from "@/shared/notifications/staffActionNotificationDelivery";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type StaffActionNotificationMaterial = {
  deliveryId: string;
  outboxId: string;
  channel: "sms" | "email";
  salonId: string;
  bookingId: string;
  requestId: string;
  event: StaffActionNotificationEvent;
  occurrenceVersion: number;
  actorUserId: string | null;
  actorRole: string;
  materialFingerprint: string;
  sendAfter: string;
  expiresAt: string;
  snapshot: {
    clientName: string;
    clientPhone: string | null;
    clientEmail: string | null;
    locale: "en" | "vi";
    startTimeUtc: string;
    serviceId: string;
    serviceName: string;
    staffId: string | null;
    staffName: string | null;
    salonName: string;
    salonSlug: string;
    salonTimezone: string;
    salonPhone: string | null;
    salonLogoUrl: string | null;
    salonIsTest: boolean;
    smsOutboundEnabled: boolean;
    emailOutboundEnabled: boolean;
    requestedChannels: { sms: boolean; email: boolean };
  };
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.length > max || /[\u0000]/.test(value)) return null;
  const normalized = value.trim();
  return normalized || allowEmpty ? normalized : null;
}

function uuid(value: unknown): string | null {
  const candidate = text(value, 80);
  return candidate && UUID_RE.test(candidate) ? candidate : null;
}

function nullableText(value: unknown, max: number): string | null | undefined {
  return value === null ? null : text(value, max) ?? undefined;
}

function email(value: unknown): string | null | undefined {
  if (value === null) return null;
  const candidate = text(value, 320)?.toLowerCase();
  return candidate && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) &&
      !/[\u0000-\u001f\u007f]/.test(candidate)
    ? candidate
    : undefined;
}

function event(value: unknown): StaffActionNotificationEvent | null {
  return value === "create" || value === "reschedule" || value === "cancel" ||
      value === "staff_change"
    ? value
    : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function actor(value: unknown, role: unknown): { userId: string | null; role: string } | null {
  const actorRole = text(role, 40);
  if (!actorRole || !/^[a-z][a-z0-9_]{0,39}$/.test(actorRole)) return null;
  if (value === null && (actorRole === "system" || actorRole === "demo_cookie")) {
    return { userId: null, role: actorRole };
  }
  const userId = uuid(value);
  return userId ? { userId, role: actorRole } : null;
}

function exactChannels(value: unknown): { sms: boolean; email: boolean } | null {
  return record(value) && Object.keys(value).length === 2 &&
      typeof value.sms === "boolean" && typeof value.email === "boolean"
    ? { sms: value.sms, email: value.email }
    : null;
}

export function parseStaffActionNotificationMaterial(
  value: unknown,
): StaffActionNotificationMaterial | null {
  if (!record(value) || value.success !== true || value.code !== "loaded" ||
      value.status !== "awaiting_material" || !record(value.material)) return null;
  const snapshot = value.material;
  const deliveryId = uuid(value.delivery_id);
  const outboxId = uuid(value.outbox_id);
  const channel = value.channel === "sms" || value.channel === "email" ? value.channel : null;
  const salonId = uuid(value.salon_id);
  const bookingId = uuid(value.booking_id);
  const requestId = uuid(value.request_id);
  const notificationEvent = event(value.event);
  const occurrenceVersion = safeInteger(value.occurrence_version);
  const actorIdentity = actor(value.actor_user_id, value.actor_role);
  const materialFingerprint = text(value.material_fingerprint, 64);
  const sendAfter = canonicalizeStrictRfc3339Instant(value.send_after);
  const expiresAt = canonicalizeStrictRfc3339Instant(value.expires_at);
  const materialSalonId = uuid(snapshot.salon_id);
  const materialBookingId = uuid(snapshot.booking_id);
  const materialRequestId = uuid(snapshot.request_id);
  const materialEvent = event(snapshot.event);
  const materialOccurrence = safeInteger(snapshot.occurrence_version);
  const materialActor = actor(snapshot.actor_user_id, snapshot.actor_role);
  const clientName = text(snapshot.client_name, 200, true);
  const clientPhone = snapshot.client_phone === null
    ? null
    : typeof snapshot.client_phone === "string" && /^\d{8,15}$/.test(snapshot.client_phone)
      ? snapshot.client_phone
      : undefined;
  const clientEmail = email(snapshot.client_email);
  const locale = snapshot.locale === "en" || snapshot.locale === "vi" ? snapshot.locale : null;
  const startTimeUtc = canonicalizeStrictRfc3339Instant(snapshot.start_time_utc);
  const serviceId = uuid(snapshot.service_id);
  const serviceName = text(snapshot.service_name, 300);
  const staffId = snapshot.staff_id === null ? null : uuid(snapshot.staff_id);
  const staffName = nullableText(snapshot.staff_name, 300);
  const salonName = text(snapshot.salon_name, 300);
  const salonSlug = text(snapshot.salon_slug, 100);
  const salonTimezone = text(snapshot.salon_timezone, 100);
  const salonPhone = nullableText(snapshot.salon_phone, 80);
  const salonLogoUrl = nullableText(snapshot.salon_logo_url, 2_048);
  const channels = exactChannels(snapshot.requested_channels);
  if (!deliveryId || !outboxId || !channel || !salonId || !bookingId || !requestId ||
      !notificationEvent || occurrenceVersion === null || !actorIdentity ||
      !materialFingerprint || !SHA256_RE.test(materialFingerprint) || !sendAfter || !expiresAt ||
      Date.parse(expiresAt) <= Date.parse(sendAfter) || snapshot.contract_version !== 1 ||
      materialSalonId !== salonId || materialBookingId !== bookingId ||
      materialRequestId !== requestId || materialEvent !== notificationEvent ||
      materialOccurrence !== occurrenceVersion || !materialActor ||
      materialActor.userId !== actorIdentity.userId || materialActor.role !== actorIdentity.role ||
      clientName === null || clientPhone === undefined || clientEmail === undefined || !locale ||
      !startTimeUtc || !serviceId || !serviceName || staffName === undefined ||
      (staffId === null) !== (staffName === null) || !salonName || !salonSlug ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(salonSlug) || !salonTimezone ||
      salonPhone === undefined || salonLogoUrl === undefined ||
      typeof snapshot.salon_is_test !== "boolean" ||
      typeof snapshot.sms_outbound_enabled !== "boolean" ||
      typeof snapshot.email_outbound_enabled !== "boolean" || !channels || !channels[channel]) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: salonTimezone }).format(new Date(0));
  } catch {
    return null;
  }
  return {
    deliveryId,
    outboxId,
    channel,
    salonId,
    bookingId,
    requestId,
    event: notificationEvent,
    occurrenceVersion,
    actorUserId: actorIdentity.userId,
    actorRole: actorIdentity.role,
    materialFingerprint,
    sendAfter,
    expiresAt,
    snapshot: {
      clientName,
      clientPhone,
      clientEmail,
      locale,
      startTimeUtc,
      serviceId,
      serviceName,
      staffId,
      staffName,
      salonName,
      salonSlug,
      salonTimezone,
      salonPhone,
      salonLogoUrl,
      salonIsTest: snapshot.salon_is_test,
      smsOutboundEnabled: snapshot.sms_outbound_enabled,
      emailOutboundEnabled: snapshot.email_outbound_enabled,
      requestedChannels: channels,
    },
  };
}

function subtitle(eventType: StaffActionNotificationEvent, locale: "en" | "vi"): string {
  if (locale === "vi") {
    return eventType === "staff_change"
      ? "Nhân viên phục vụ đã được cập nhật"
      : eventType === "reschedule"
      ? "Lịch hẹn đã được dời"
      : eventType === "cancel"
        ? "Lịch hẹn đã huỷ"
        : "Lịch hẹn đã xác nhận";
  }
  return eventType === "staff_change"
    ? "Appointment Provider Updated"
    : eventType === "reschedule"
    ? "Appointment Rescheduled"
    : eventType === "cancel"
      ? "Appointment Cancelled"
      : "Appointment Confirmed";
}

export function buildStaffActionNotificationEnvelope(
  material: StaffActionNotificationMaterial,
  input: { siteUrl: string },
): ReturnType<typeof serializeStaffActionNotificationEnvelope> | null {
  let siteUrl: URL;
  try {
    siteUrl = new URL(input.siteUrl);
    if (siteUrl.protocol !== "https:" || siteUrl.username || siteUrl.password) return null;
  } catch {
    return null;
  }
  const snapshot = material.snapshot;
  let whenLabel: string;
  try {
    whenLabel = new Intl.DateTimeFormat(snapshot.locale === "vi" ? "vi-VN" : "en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: snapshot.salonTimezone,
    }).format(new Date(material.snapshot.startTimeUtc));
  } catch {
    return null;
  }
  const message = buildStaffActionSms(material.event, snapshot.locale, {
    customerName: snapshot.clientName,
    salonName: snapshot.salonName,
    serviceName: snapshot.serviceName,
    whenLabel,
    salonPhone: snapshot.salonPhone,
    staffName: snapshot.staffName,
  });
  if (!message) return null;
  const base = {
    v: 1 as const,
    kind: "staff_action" as const,
    salonId: material.salonId,
    bookingId: material.bookingId,
    event: material.event,
    actorUserId: material.actorUserId,
    actorRole: material.actorRole,
  };
  let envelope: StaffActionNotificationEnvelope;
  if (material.channel === "sms") {
    if (!snapshot.clientPhone || !snapshot.smsOutboundEnabled) return null;
    const optOut = snapshot.locale === "vi"
      ? "Nhắn STOP để ngừng nhận tin."
      : "Reply STOP to opt out.";
    envelope = {
      ...base,
      channel: "sms",
      to: `+${snapshot.clientPhone}`,
      body: /\bSTOP\b/i.test(message) ? message : `${message}\n${optOut}`,
      statusCallbackUrl: new URL("/api/twilio/status", siteUrl).toString(),
      salonIsTest: snapshot.salonIsTest,
      lang: snapshot.locale,
    };
  } else {
    if (!snapshot.clientEmail || !snapshot.emailOutboundEnabled) return null;
    const subject = buildStaffActionEmailSubject(material.event, snapshot.locale, snapshot.salonName);
    if (!subject) return null;
    const html = `<!DOCTYPE html><html lang="${snapshot.locale}"><body style="margin:0;padding:0;background:#faf9f7;">
  <main style="max-width:480px;margin:0 auto;padding:28px 22px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#2a2a2a;">
    <div style="padding:16px;background:#0B0C10;text-align:center;border-radius:8px;margin:0 0 18px;">
      ${buildEmailBrandHeader({ salonName: snapshot.salonName, logoUrl: snapshot.salonLogoUrl, subtitle: subtitle(material.event, snapshot.locale) })}
    </div>
    <h1 style="margin:0 0 18px;font-size:18px;font-weight:600;color:#1a1a1a;">${escapeEmailHtml(subject)}</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#333;">${escapeEmailHtml(message)}</p>
  </main>
  ${complianceFooterHtml({ email: snapshot.clientEmail, salonName: snapshot.salonName, lang: snapshot.locale })}
</body></html>`;
    envelope = {
      ...base,
      channel: "email",
      to: snapshot.clientEmail,
      from: getResendFrom(),
      subject,
      html,
      text: message,
      headers: listUnsubscribeHeaders(snapshot.clientEmail),
      replyTo: null,
    };
  }
  return serializeStaffActionNotificationEnvelope(envelope);
}
