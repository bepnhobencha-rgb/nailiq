import "server-only";

import { createHash } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_ENVELOPE_BYTES = 256 * 1024;

export type StaffActionNotificationEvent =
  | "create"
  | "reschedule"
  | "cancel"
  | "staff_change";
export type StaffActionNotificationStatus = "sent" | "failed" | "suppressed" | "unknown";
export type StaffActionFailureDisposition =
  | "none"
  | "retryable_pre_acceptance"
  | "permanent";

type StaffActionEnvelopeBase = {
  v: 1;
  kind: "staff_action";
  salonId: string;
  bookingId: string;
  event: StaffActionNotificationEvent;
  actorUserId: string | null;
  actorRole: string;
};

export type StaffActionSmsEnvelope = StaffActionEnvelopeBase & {
  channel: "sms";
  to: string;
  body: string;
  statusCallbackUrl: string;
  salonIsTest: boolean;
  lang: "en" | "vi";
};

export type StaffActionEmailEnvelope = StaffActionEnvelopeBase & {
  channel: "email";
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  replyTo: string | null;
};

export type StaffActionNotificationEnvelope =
  | StaffActionSmsEnvelope
  | StaffActionEmailEnvelope;

export type StaffActionNotificationLease = {
  deliveryId: string;
  eventId: string;
  attemptToken: string;
  attemptCount: number;
  envelopeFingerprint: string;
  envelope: StaffActionNotificationEnvelope;
};

export type StaffActionNotificationDeliveryDeps = {
  sendSms(envelope: StaffActionSmsEnvelope): Promise<{
    ok: boolean;
    messageSid?: string;
    error?: string;
    suppressed?: boolean;
    suppressionReason?: string;
  }>;
  sendEmail(envelope: StaffActionEmailEnvelope): Promise<{
    data?: { id?: string | null } | null;
    error?: { statusCode?: unknown; code?: unknown } | null;
    suppressed?: boolean;
    suppressionReason?: string;
  }>;
  complete(input: {
    deliveryId: string;
    attemptToken: string;
    status: StaffActionNotificationStatus;
    providerMessageId: string | null;
    errorCode: string | null;
    failureDisposition: StaffActionFailureDisposition;
  }): Promise<{ success: boolean; code: string }>;
};

export type StaffActionNotificationDeliveryResult = {
  deliveryId: string | null;
  outcome: "accepted" | "rejected" | "suppressed" | "unknown";
  reason: string;
  providerMessageId: string | null;
  finalized: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
      !value.includes("\u0000")
    ? value
    : null;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

function event(value: unknown): StaffActionNotificationEvent | null {
  return value === "create" || value === "reschedule" || value === "cancel" ||
      value === "staff_change"
    ? value
    : null;
}

function actor(value: unknown, role: unknown): { userId: string | null; role: string } | null {
  const actorRole = boundedText(role, 40);
  if (!actorRole || !/^[a-z][a-z0-9_]{0,39}$/.test(actorRole)) return null;
  if (value === null && (actorRole === "system" || actorRole === "demo_cookie")) {
    return { userId: null, role: actorRole };
  }
  const userId = uuid(value);
  return userId ? { userId, role: actorRole } : null;
}

function email(value: unknown): string | null {
  const candidate = boundedText(value, 320)?.trim().toLowerCase() ?? null;
  return candidate && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) &&
      !/[\u0000-\u001f\u007f]/.test(candidate)
    ? candidate
    : null;
}

function headers(value: unknown): Record<string, string> | null {
  if (!record(value) || Object.keys(value).length > 20) return null;
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(key) || typeof item !== "string" ||
        item.length === 0 || item.length > 2_048 || /[\r\n\u0000]/.test(item)) return null;
  }
  return value as Record<string, string>;
}

export function parseStaffActionNotificationEnvelope(
  value: unknown,
): StaffActionNotificationEnvelope | null {
  if (!record(value) || value.v !== 1 || value.kind !== "staff_action") return null;
  const salonId = uuid(value.salonId);
  const bookingId = uuid(value.bookingId);
  const action = event(value.event);
  const actorIdentity = actor(value.actorUserId, value.actorRole);
  if (!salonId || !bookingId || !action || !actorIdentity) return null;

  const base: StaffActionEnvelopeBase = {
    v: 1,
    kind: "staff_action",
    salonId,
    bookingId,
    event: action,
    actorUserId: actorIdentity.userId,
    actorRole: actorIdentity.role,
  };

  if (value.channel === "sms") {
    const to = boundedText(value.to, 20);
    const body = boundedText(value.body, 4_000);
    const statusCallbackUrl = boundedText(value.statusCallbackUrl, 2_048);
    if (!to || !/^\+[1-9]\d{7,14}$/.test(to) || !body || !statusCallbackUrl ||
        typeof value.salonIsTest !== "boolean" ||
        (value.lang !== "en" && value.lang !== "vi")) return null;
    try {
      if (new URL(statusCallbackUrl).protocol !== "https:") return null;
    } catch {
      return null;
    }
    return {
      ...base,
      channel: "sms",
      to,
      body,
      statusCallbackUrl,
      salonIsTest: value.salonIsTest,
      lang: value.lang,
    };
  }

  if (value.channel !== "email") return null;
  const to = email(value.to);
  const from = boundedText(value.from, 320);
  const subject = boundedText(value.subject, 998);
  const html = boundedText(value.html, 240_000);
  const text = boundedText(value.text, 10_000);
  const parsedHeaders = headers(value.headers);
  const replyTo = value.replyTo === null ? null : email(value.replyTo);
  if (!to || !from || /[\r\n]/.test(from) || !subject || /[\r\n]/.test(subject) ||
      !html || !text || !parsedHeaders || (value.replyTo !== null && !replyTo)) return null;
  return {
    ...base,
    channel: "email",
    to,
    from,
    subject,
    html,
    text,
    headers: parsedHeaders,
    replyTo,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function serializeStaffActionNotificationEnvelope(
  envelope: StaffActionNotificationEnvelope,
): { envelope: string; envelopeFingerprint: string; recipientFingerprint: string } | null {
  const parsed = parseStaffActionNotificationEnvelope(envelope);
  if (!parsed) return null;
  const text = JSON.stringify(parsed);
  const recipient = parsed.channel === "sms"
    ? parsed.to.replace(/\D/g, "")
    : parsed.to.trim().toLowerCase();
  return Buffer.byteLength(text, "utf8") <= MAX_ENVELOPE_BYTES
    ? {
        envelope: text,
        envelopeFingerprint: sha256(text),
        recipientFingerprint: sha256(recipient),
      }
    : null;
}

export function parseStaffActionNotificationLease(
  value: unknown,
): StaffActionNotificationLease | null {
  if (!record(value) || value.success !== true ||
      (value.code !== "delivery_claimed" && value.code !== "delivery_attempt_replay")) return null;
  const deliveryId = uuid(value.delivery_id);
  const eventId = uuid(value.event_id);
  const attemptToken = uuid(value.attempt_token);
  const attemptCount = typeof value.attempt_count === "number" &&
      Number.isSafeInteger(value.attempt_count) && value.attempt_count > 0
    ? value.attempt_count
    : null;
  const envelopeFingerprint = typeof value.envelope_fingerprint === "string" &&
      SHA256_RE.test(value.envelope_fingerprint)
    ? value.envelope_fingerprint
    : null;
  if (!deliveryId || !eventId || !attemptToken || !attemptCount || !envelopeFingerprint ||
      typeof value.dispatch_envelope !== "string" ||
      Buffer.byteLength(value.dispatch_envelope, "utf8") > MAX_ENVELOPE_BYTES ||
      sha256(value.dispatch_envelope) !== envelopeFingerprint) return null;
  let rawEnvelope: unknown;
  try {
    rawEnvelope = JSON.parse(value.dispatch_envelope);
  } catch {
    return null;
  }
  const envelope = parseStaffActionNotificationEnvelope(rawEnvelope);
  if (!envelope || JSON.stringify(envelope) !== value.dispatch_envelope) return null;
  return { deliveryId, eventId, attemptToken, attemptCount, envelopeFingerprint, envelope };
}

function providerReceipt(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 255 &&
      !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim()
    : null;
}

function twilioReceipt(value: unknown): string | null {
  return typeof value === "string" && /^(SM|MM)[0-9a-fA-F]{32}$/.test(value)
    ? value
    : null;
}

type Classified = Omit<StaffActionNotificationDeliveryResult, "deliveryId" | "finalized"> & {
  status: StaffActionNotificationStatus;
  errorCode: string | null;
  failureDisposition: StaffActionFailureDisposition;
};

async function dispatch(
  envelope: StaffActionNotificationEnvelope,
  deps: StaffActionNotificationDeliveryDeps,
): Promise<Classified> {
  if (envelope.channel === "sms") {
    try {
      const result = await deps.sendSms(envelope);
      if (!result.ok && (
        result.error === "sms_policy_unavailable" ||
        result.error === "sms_consent_unavailable"
      )) {
        const reason = result.error === "sms_policy_unavailable"
          ? "sms_policy_unavailable_pre_acceptance"
          : "consent_unavailable_pre_acceptance";
        return {
          outcome: "rejected", reason, status: "failed",
          providerMessageId: null, errorCode: reason,
          failureDisposition: "retryable_pre_acceptance",
        };
      }
      if (result.suppressed) {
        return {
          outcome: "suppressed",
          reason: result.suppressionReason ?? "channel_disabled",
          status: "suppressed",
          providerMessageId: null,
          errorCode: result.suppressionReason ?? "channel_disabled",
          failureDisposition: "permanent",
        };
      }
      const receipt = result.ok ? twilioReceipt(result.messageSid) : null;
      if (receipt) return {
        outcome: "accepted", reason: "provider_accepted", status: "sent",
        providerMessageId: receipt, errorCode: null, failureDisposition: "none",
      };
      const providerStatus = Number(/^twilio_(\d{3})$/.exec(result.error ?? "")?.[1]);
      if (!result.ok && (providerStatus === 429 || [500, 502, 503, 504].includes(providerStatus))) {
        const reason = providerStatus === 429
          ? "sms_rate_limited_pre_acceptance"
          : "sms_unavailable_pre_acceptance";
        return {
          outcome: "rejected", reason, status: "failed", providerMessageId: null,
          errorCode: reason, failureDisposition: "retryable_pre_acceptance",
        };
      }
      if (!result.ok && (result.error === "invalid_phone" || result.error === "twilio_not_configured" ||
          providerStatus >= 400 && providerStatus < 500)) {
        const reason = result.error === "invalid_phone"
          ? "invalid_recipient"
          : result.error === "twilio_not_configured"
            ? "provider_configuration_invalid"
            : "provider_policy_rejected";
        return {
          outcome: "rejected", reason, status: "failed", providerMessageId: null,
          errorCode: reason, failureDisposition: "permanent",
        };
      }
      return {
        outcome: "unknown",
        reason: result.ok ? "invalid_provider_receipt" : "provider_outcome_unknown",
        status: "unknown", providerMessageId: null,
        errorCode: result.ok ? "invalid_provider_receipt" : "provider_outcome_unknown",
        failureDisposition: "none",
      };
    } catch {
      return {
        outcome: "unknown", reason: "provider_exception", status: "unknown",
        providerMessageId: null, errorCode: "provider_exception", failureDisposition: "none",
      };
    }
  }

  try {
    const result = await deps.sendEmail(envelope);
    if (result.suppressed) return {
      outcome: "suppressed",
      reason: result.suppressionReason ?? "consent_revoked",
      status: "suppressed",
      providerMessageId: null,
      errorCode: "consent_revoked",
      failureDisposition: "permanent",
    };
    const receipt = providerReceipt(result.data?.id);
    if (!result.error && receipt) return {
      outcome: "accepted", reason: "provider_accepted", status: "sent",
      providerMessageId: receipt, errorCode: null, failureDisposition: "none",
    };
    if (result.error && receipt) return {
      outcome: "unknown", reason: "provider_outcome_unknown", status: "unknown",
      providerMessageId: null, errorCode: "provider_outcome_unknown", failureDisposition: "none",
    };
    if (result.error) {
      const status = Number(result.error.statusCode);
      if (result.error.code === "provider_configuration_invalid") return {
        outcome: "rejected", reason: "provider_configuration_invalid", status: "failed",
        providerMessageId: null, errorCode: "provider_configuration_invalid",
        failureDisposition: "permanent",
      };
      if (status === 429 || [500, 502, 503, 504].includes(status)) {
        const reason = status === 429
          ? "email_rate_limited_pre_acceptance"
          : "email_unavailable_pre_acceptance";
        return {
          outcome: "rejected", reason, status: "failed", providerMessageId: null,
          errorCode: reason, failureDisposition: "retryable_pre_acceptance",
        };
      }
      const reason = status === 401 || status === 403
          ? "provider_auth_invalid"
          : "provider_policy_rejected";
      return {
        outcome: "rejected", reason, status: "failed", providerMessageId: null,
        errorCode: reason, failureDisposition: "permanent",
      };
    }
    return {
      outcome: "unknown", reason: "invalid_provider_receipt", status: "unknown",
      providerMessageId: null, errorCode: "invalid_provider_receipt", failureDisposition: "none",
    };
  } catch {
    return {
      outcome: "unknown", reason: "provider_exception", status: "unknown",
      providerMessageId: null, errorCode: "provider_exception", failureDisposition: "none",
    };
  }
}

export async function deliverClaimedStaffActionNotification(
  rawLease: unknown,
  deps: StaffActionNotificationDeliveryDeps,
): Promise<StaffActionNotificationDeliveryResult> {
  const lease = parseStaffActionNotificationLease(rawLease);
  if (!lease) return {
    deliveryId: null, outcome: "rejected", reason: "invalid_claim",
    providerMessageId: null, finalized: false,
  };
  const classified = await dispatch(lease.envelope, deps);
  let completion: { success: boolean; code: string } | null = null;
  try {
    completion = await deps.complete({
      deliveryId: lease.deliveryId,
      attemptToken: lease.attemptToken,
      status: classified.status,
      providerMessageId: classified.providerMessageId,
      errorCode: classified.errorCode,
      failureDisposition: classified.failureDisposition,
    });
  } catch {
    completion = null;
  }
  return {
    deliveryId: lease.deliveryId,
    outcome: classified.outcome,
    reason: completion?.success === true ? classified.reason : "completion_unavailable",
    providerMessageId: classified.providerMessageId,
    finalized: completion?.success === true,
  };
}
