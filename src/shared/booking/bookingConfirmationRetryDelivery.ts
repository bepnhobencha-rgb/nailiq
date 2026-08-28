import "server-only";

import { createHash } from "node:crypto";
import { getResendClient } from "@/shared/lib/resend";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { customerEmailDeliverySuppressionReason } from "@/shared/notifications/customerEmailDeliverySuppression";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_ENVELOPE_BYTES = 256 * 1024;

export type BookingConfirmationSmsEnvelope = {
  v: 1;
  channel: "sms";
  salonId: string;
  to: string;
  body: string;
  statusCallbackUrl: string;
  salonIsTest: boolean;
  lang: "en" | "vi";
};

export type BookingConfirmationEmailEnvelope = {
  v: 1;
  channel: "email";
  salonId: string;
  to: string;
  from: string;
  subject: string;
  html: string;
  headers: Record<string, string>;
  replyTo: string | null;
  attachments: Array<{
    filename: string;
    content: string;
    contentType: string;
  }>;
};

export type BookingConfirmationDispatchEnvelope =
  | BookingConfirmationSmsEnvelope
  | BookingConfirmationEmailEnvelope;

type Claim = {
  success: boolean;
  code: string;
  claimed: boolean;
  claimId: string | null;
  attemptToken: string | null;
  attemptCount: number | null;
};

type Completion = { success: boolean; code: string };

export type BookingConfirmationRetryDeliveryDeps = {
  claim(input: {
    salonId: string;
    bookingId: string;
    channel: "sms" | "email";
    payloadFingerprint: string;
    recipientFingerprint: string;
    dispatchEnvelope: string;
  }): Promise<Claim>;
  complete(input: {
    claimId: string;
    attemptToken: string;
    status: "sent" | "failed" | "suppressed" | "unknown";
    providerMessageId: string | null;
    errorCode: string | null;
    failureDisposition: "none" | "retryable_pre_acceptance" | "permanent";
  }): Promise<Completion>;
  sendSms(envelope: BookingConfirmationSmsEnvelope): Promise<{
    ok: boolean;
    messageSid?: string;
    error?: string;
    suppressed?: boolean;
    suppressionReason?: string;
  }>;
  sendEmail(envelope: BookingConfirmationEmailEnvelope, context: {
    claimId: string;
  }): Promise<{
    data?: { id?: string | null } | null;
    error?: { statusCode?: unknown; code?: unknown } | null;
  }>;
  emailSuppressionReason(input: {
    salonId: string;
    email: string;
  }): Promise<string | null>;
};

export type BookingConfirmationDeliveryResult = {
  outcome: "accepted" | "rejected" | "suppressed" | "unknown";
  reason: string;
  claimId: string | null;
  providerMessageId: string | null;
  finalized: boolean;
};

type Lease = {
  claimId: string;
  attemptToken: string;
  attemptCount: number;
  salonId: string;
  bookingId: string;
  channel: "sms" | "email";
  payloadFingerprint: string;
  recipientFingerprint: string;
  dispatchEnvelope: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}

function emailAddress(value: unknown): string | null {
  const candidate = boundedText(value, 320);
  return candidate && candidate.includes("@") && !/[\u0000-\u001f\u007f]/.test(candidate)
    ? candidate
    : null;
}

function validHeaders(value: unknown): value is Record<string, string> {
  return record(value) && Object.keys(value).length <= 20 &&
    Object.entries(value).every(([key, item]) =>
      /^[A-Za-z0-9-]{1,80}$/.test(key) && typeof item === "string" &&
      boundedText(item, 2_048) !== null && !/[\r\n]/.test(item));
}

function parseEnvelope(value: unknown): BookingConfirmationDispatchEnvelope | null {
  if (!record(value) || value.v !== 1 || !UUID_RE.test(String(value.salonId ?? ""))) return null;
  if (value.channel === "sms") {
    const to = boundedText(value.to, 80);
    const body = boundedText(value.body, 4_000);
    const statusCallbackUrl = boundedText(value.statusCallbackUrl, 2_048);
    if (!to || !body || !statusCallbackUrl || typeof value.salonIsTest !== "boolean" ||
        (value.lang !== "en" && value.lang !== "vi")) return null;
    try {
      const callback = new URL(statusCallbackUrl);
      if (callback.protocol !== "https:") return null;
    } catch {
      return null;
    }
    return {
      v: 1,
      channel: "sms",
      salonId: String(value.salonId),
      to,
      body,
      statusCallbackUrl,
      salonIsTest: value.salonIsTest,
      lang: value.lang,
    };
  }
  if (value.channel !== "email") return null;
  const to = emailAddress(value.to);
  const from = boundedText(value.from, 320);
  const subject = boundedText(value.subject, 998);
  const html = boundedText(value.html, 240_000);
  const replyTo = value.replyTo === null ? null : emailAddress(value.replyTo);
  if (!to || !from || /[\r\n]/.test(from) || !subject || /[\r\n]/.test(subject) || !html ||
      replyTo === null && value.replyTo !== null ||
      !validHeaders(value.headers) || !Array.isArray(value.attachments) || value.attachments.length > 3) return null;
  const attachments: BookingConfirmationEmailEnvelope["attachments"] = [];
  for (const raw of value.attachments) {
    if (!record(raw)) return null;
    const filename = boundedText(raw.filename, 255);
    const content = boundedText(raw.content, 128_000);
    const contentType = boundedText(raw.contentType, 255);
    if (!filename || !content || !contentType) return null;
    attachments.push({ filename, content, contentType });
  }
  return {
    v: 1,
    channel: "email",
    salonId: String(value.salonId),
    to,
    from,
    subject,
    html,
    headers: value.headers,
    replyTo,
    attachments,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function recipientMaterial(envelope: BookingConfirmationDispatchEnvelope): string {
  return envelope.channel === "sms"
    ? envelope.to.replace(/\D/g, "")
    : envelope.to.trim().toLowerCase();
}

export function serializeBookingConfirmationEnvelope(
  envelope: BookingConfirmationDispatchEnvelope,
): { text: string; payloadFingerprint: string; recipientFingerprint: string } | null {
  const parsed = parseEnvelope(envelope);
  if (!parsed || parsed.channel !== envelope.channel || parsed.salonId !== envelope.salonId) return null;
  const text = JSON.stringify(parsed);
  if (Buffer.byteLength(text, "utf8") > MAX_ENVELOPE_BYTES) return null;
  return {
    text,
    payloadFingerprint: sha256(text),
    recipientFingerprint: sha256(recipientMaterial(parsed)),
  };
}

function twilioReceipt(value: unknown): string | null {
  return typeof value === "string" && /^(SM|MM)[0-9a-fA-F]{32}$/.test(value)
    ? value
    : null;
}

function providerReceipt(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
}

type Classified = {
  outcome: BookingConfirmationDeliveryResult["outcome"];
  reason: string;
  status: "sent" | "failed" | "suppressed" | "unknown";
  providerMessageId: string | null;
  errorCode: string | null;
  failureDisposition: "none" | "retryable_pre_acceptance" | "permanent";
};

async function dispatch(
  envelope: BookingConfirmationDispatchEnvelope,
  deps: BookingConfirmationRetryDeliveryDeps,
  claimId: string,
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
        const consent = result.suppressionReason === "provider_stop" ||
          result.suppressionReason === "salon_suppression" ||
          result.suppressionReason === "consent_revoked";
        return {
          outcome: "suppressed", reason: result.suppressionReason ?? "channel_disabled",
          status: "suppressed", providerMessageId: null,
          errorCode: consent ? "consent_revoked" : "channel_disabled",
          failureDisposition: "permanent",
        };
      }
      const receipt = result.ok ? twilioReceipt(result.messageSid) : null;
      if (receipt) return {
        outcome: "accepted", reason: "provider_accepted", status: "sent",
        providerMessageId: receipt, errorCode: null, failureDisposition: "none",
      };
      const status = Number(/^twilio_(\d{3})$/.exec(result.error ?? "")?.[1]);
      if (!result.ok && status === 429) return {
        outcome: "rejected", reason: "sms_rate_limited_pre_acceptance", status: "failed",
        providerMessageId: null, errorCode: "sms_rate_limited_pre_acceptance",
        failureDisposition: "retryable_pre_acceptance",
      };
      if (!result.ok && [500, 502, 503, 504].includes(status)) return {
        outcome: "rejected", reason: "sms_unavailable_pre_acceptance", status: "failed",
        providerMessageId: null, errorCode: "sms_unavailable_pre_acceptance",
        failureDisposition: "retryable_pre_acceptance",
      };
      if (result.error === "invalid_phone") return {
        outcome: "rejected", reason: "invalid_recipient", status: "failed",
        providerMessageId: null, errorCode: "invalid_recipient", failureDisposition: "permanent",
      };
      if (result.error === "twilio_not_configured") return {
        outcome: "rejected", reason: "provider_configuration_invalid", status: "failed",
        providerMessageId: null, errorCode: "provider_configuration_invalid", failureDisposition: "permanent",
      };
      if (!result.ok && status >= 400 && status < 500) return {
        outcome: "rejected", reason: "provider_policy_rejected", status: "failed",
        providerMessageId: null, errorCode: "provider_policy_rejected", failureDisposition: "permanent",
      };
      return {
        outcome: "unknown", reason: result.ok ? "invalid_provider_receipt" : "provider_outcome_unknown",
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
    const result = await deps.sendEmail(envelope, { claimId });
    const receipt = providerReceipt(result.data?.id);
    if (result.error && receipt) return {
      outcome: "unknown", reason: "provider_outcome_unknown", status: "unknown",
      providerMessageId: null, errorCode: "provider_outcome_unknown", failureDisposition: "none",
    };
    if (!result.error && receipt) return {
      outcome: "accepted", reason: "provider_accepted", status: "sent",
      providerMessageId: receipt, errorCode: null, failureDisposition: "none",
    };
    if (result.error) {
      const status = Number(result.error.statusCode);
      if (result.error.code === "provider_configuration_invalid") return {
        outcome: "rejected", reason: "provider_configuration_invalid", status: "failed",
        providerMessageId: null, errorCode: "provider_configuration_invalid",
        failureDisposition: "permanent",
      };
      const retryCode = status === 429
        ? "email_rate_limited_pre_acceptance"
        : [500, 502, 503, 504].includes(status)
          ? "email_unavailable_pre_acceptance"
          : null;
      if (retryCode) return {
        outcome: "rejected", reason: retryCode, status: "failed",
        providerMessageId: null, errorCode: retryCode,
        failureDisposition: "retryable_pre_acceptance",
      };
      const errorCode = status === 401 || status === 403
        ? "provider_auth_invalid"
        : "provider_policy_rejected";
      return {
        outcome: "rejected", reason: errorCode, status: "failed",
        providerMessageId: null, errorCode, failureDisposition: "permanent",
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

async function dispatchClaimed(
  envelope: BookingConfirmationDispatchEnvelope,
  claimId: string,
  attemptToken: string,
  deps: BookingConfirmationRetryDeliveryDeps,
  suppressionReason?: string,
): Promise<BookingConfirmationDeliveryResult> {
  let resolvedSuppressionReason = suppressionReason;
  if (!resolvedSuppressionReason && envelope.channel === "email") {
    try {
      resolvedSuppressionReason = await deps.emailSuppressionReason({
        salonId: envelope.salonId,
        email: envelope.to,
      }) ?? undefined;
    } catch {
      resolvedSuppressionReason = "suppression_lookup_unavailable";
    }
  }
  const suppressionLookupUnavailable = resolvedSuppressionReason === "lookup_unavailable" ||
    resolvedSuppressionReason === "suppression_lookup_unavailable";
  const classified: Classified = suppressionLookupUnavailable
    ? {
        outcome: "rejected", reason: "suppression_lookup_unavailable", status: "failed",
        providerMessageId: null, errorCode: "suppression_lookup_unavailable",
        failureDisposition: "retryable_pre_acceptance",
      }
    : resolvedSuppressionReason
      ? {
          outcome: "suppressed", reason: resolvedSuppressionReason, status: "suppressed",
          providerMessageId: null, errorCode: "channel_disabled", failureDisposition: "permanent",
        }
      : await dispatch(envelope, deps, claimId);
  let completion: Completion = { success: false, code: "completion_unavailable" };
  try {
    completion = await deps.complete({
      claimId,
      attemptToken,
      status: classified.status,
      providerMessageId: classified.providerMessageId,
      errorCode: classified.errorCode,
      failureDisposition: classified.failureDisposition,
    });
  } catch {
    // Response loss is never evidence that completion failed to commit.
  }
  return {
    outcome: classified.outcome,
    reason: completion.success || completion.code === "already_completed"
      ? classified.reason
      : "completion_unavailable",
    claimId,
    providerMessageId: classified.providerMessageId,
    finalized: completion.success || completion.code === "already_completed",
  };
}

export async function deliverBookingConfirmation(
  input: {
    bookingId: string;
    salonId: string;
    envelope: BookingConfirmationDispatchEnvelope;
    suppressionReason?: string;
  },
  deps: BookingConfirmationRetryDeliveryDeps = defaultDeps,
): Promise<BookingConfirmationDeliveryResult> {
  if (!UUID_RE.test(input.bookingId) || !UUID_RE.test(input.salonId) ||
      input.envelope.salonId !== input.salonId) {
    return { outcome: "suppressed", reason: "invalid_dispatch", claimId: null, providerMessageId: null, finalized: false };
  }
  const serialized = serializeBookingConfirmationEnvelope(input.envelope);
  if (!serialized) {
    return { outcome: "suppressed", reason: "invalid_dispatch", claimId: null, providerMessageId: null, finalized: false };
  }
  let claim: Claim;
  try {
    claim = await deps.claim({
      salonId: input.salonId,
      bookingId: input.bookingId,
      channel: input.envelope.channel,
      payloadFingerprint: serialized.payloadFingerprint,
      recipientFingerprint: serialized.recipientFingerprint,
      dispatchEnvelope: serialized.text,
    });
  } catch {
    claim = { success: false, code: "claim_unavailable", claimed: false, claimId: null, attemptToken: null, attemptCount: null };
  }
  if (!claim.success || !claim.claimed || !claim.claimId || !claim.attemptToken) {
    return {
      outcome: "suppressed",
      reason: claim.code,
      claimId: claim.claimId,
      providerMessageId: null,
      finalized: false,
    };
  }
  if (!UUID_RE.test(claim.claimId) || !UUID_RE.test(claim.attemptToken) || claim.attemptCount !== 1) {
    return {
      outcome: "suppressed", reason: "invalid_claim", claimId: null,
      providerMessageId: null, finalized: false,
    };
  }
  return dispatchClaimed(input.envelope, claim.claimId, claim.attemptToken, deps, input.suppressionReason);
}

function parseLease(value: unknown): Lease | null {
  if (!record(value) || value.success !== true || value.code !== "leased") return null;
  const claimId = boundedText(value.claim_id, 80);
  const attemptToken = boundedText(value.attempt_token, 80);
  const salonId = boundedText(value.salon_id, 80);
  const bookingId = boundedText(value.booking_id, 80);
  const payloadFingerprint = boundedText(value.payload_fingerprint, 64);
  const recipientFingerprint = boundedText(value.recipient_fingerprint, 64);
  const dispatchEnvelope = boundedText(value.dispatch_envelope, MAX_ENVELOPE_BYTES);
  const attemptCount = value.attempt_count;
  if (!claimId || !attemptToken || !salonId || !bookingId || !payloadFingerprint ||
      !recipientFingerprint || !dispatchEnvelope || !UUID_RE.test(claimId) ||
      !UUID_RE.test(attemptToken) || !UUID_RE.test(salonId) || !UUID_RE.test(bookingId) ||
      !SHA256_RE.test(payloadFingerprint) || !SHA256_RE.test(recipientFingerprint) ||
      attemptCount !== 2 || (value.channel !== "sms" && value.channel !== "email")) return null;
  return { claimId, attemptToken, attemptCount, salonId, bookingId, channel: value.channel, payloadFingerprint, recipientFingerprint, dispatchEnvelope };
}

export async function deliverLeasedBookingConfirmationRetry(
  raw: unknown,
  deps: BookingConfirmationRetryDeliveryDeps = defaultDeps,
): Promise<BookingConfirmationDeliveryResult> {
  const lease = parseLease(raw);
  if (!lease) return { outcome: "suppressed", reason: "invalid_retry_lease", claimId: null, providerMessageId: null, finalized: false };
  let envelope: BookingConfirmationDispatchEnvelope | null = null;
  try {
    envelope = parseEnvelope(JSON.parse(lease.dispatchEnvelope));
  } catch {
    envelope = null;
  }
  const serialized = envelope ? serializeBookingConfirmationEnvelope(envelope) : null;
  if (!envelope || !serialized || envelope.channel !== lease.channel || envelope.salonId !== lease.salonId ||
      serialized.text !== lease.dispatchEnvelope || serialized.payloadFingerprint !== lease.payloadFingerprint ||
      serialized.recipientFingerprint !== lease.recipientFingerprint) {
    const completion = await deps.complete({
      claimId: lease.claimId,
      attemptToken: lease.attemptToken,
      status: "suppressed",
      providerMessageId: null,
      errorCode: "material_changed",
      failureDisposition: "permanent",
    }).catch(() => ({ success: false, code: "completion_unavailable" }));
    const finalized = completion.success || completion.code === "already_completed";
    return {
      outcome: "suppressed",
      reason: finalized ? "material_changed" : "completion_unavailable",
      claimId: lease.claimId,
      providerMessageId: null,
      finalized,
    };
  }
  return dispatchClaimed(envelope, lease.claimId, lease.attemptToken, deps);
}

export type BookingConfirmationRetryWorkerDeps = {
  reconcile(limit: number): Promise<{ success: boolean; reconciled: number }>;
  lease(limit: number): Promise<unknown[]>;
  delivery: BookingConfirmationRetryDeliveryDeps;
};

export async function runBookingConfirmationRetryWorker(
  limit = 10,
  deps: BookingConfirmationRetryWorkerDeps = defaultWorkerDeps,
): Promise<{ staleReconciled: number; retriesProcessed: number; accepted: number; rejected: number; suppressed: number; unknown: number }> {
  const bounded = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 10;
  let reconciled = { success: false, reconciled: 0 };
  let leases: unknown[] = [];
  try { reconciled = await deps.reconcile(bounded); } catch { /* fail closed */ }
  try { leases = await deps.lease(bounded); } catch { /* fail closed */ }
  const results: BookingConfirmationDeliveryResult[] = [];
  for (const lease of leases) results.push(await deliverLeasedBookingConfirmationRetry(lease, deps.delivery));
  return {
    staleReconciled: reconciled.success ? reconciled.reconciled : 0,
    retriesProcessed: results.length,
    accepted: results.filter((item) => item.outcome === "accepted").length,
    rejected: results.filter((item) => item.outcome === "rejected").length,
    suppressed: results.filter((item) => item.outcome === "suppressed").length,
    unknown: results.filter((item) => item.outcome === "unknown").length,
  };
}

function parseClaim(value: unknown): Claim {
  if (!record(value)) return { success: false, code: "claim_unavailable", claimed: false, claimId: null, attemptToken: null, attemptCount: null };
  return {
    success: value.success === true,
    code: boundedText(value.code, 100) ?? "claim_unavailable",
    claimed: value.claimed === true,
    claimId: boundedText(value.claim_id, 80),
    attemptToken: boundedText(value.attempt_token, 80),
    attemptCount: typeof value.attempt_count === "number" ? value.attempt_count : null,
  };
}

const defaultDeps: BookingConfirmationRetryDeliveryDeps = {
  async claim(input) {
    const { data, error } = await createServiceRoleClient().rpc(
      "claim_booking_confirmation_delivery" as never,
      {
        p_salon_id: input.salonId,
        p_booking_id: input.bookingId,
        p_channel: input.channel,
        p_payload_fingerprint: input.payloadFingerprint,
        p_recipient_fingerprint: input.recipientFingerprint,
        p_dispatch_envelope: input.dispatchEnvelope,
      } as never,
    );
    return error ? parseClaim(null) : parseClaim(data);
  },
  async complete(input) {
    const { data, error } = await createServiceRoleClient().rpc(
      "complete_booking_confirmation_delivery" as never,
      {
        p_claim_id: input.claimId,
        p_attempt_token: input.attemptToken,
        p_status: input.status,
        p_provider_message_id: input.providerMessageId,
        p_error_code: input.errorCode,
        p_failure_disposition: input.failureDisposition,
      } as never,
    );
    if (error || !record(data)) return { success: false, code: "completion_unavailable" };
    return { success: data.success === true, code: boundedText(data.code, 100) ?? "completion_unavailable" };
  },
  sendSms(envelope) {
    return sendSmsReminder(envelope.to, envelope.body, {
      salonId: envelope.salonId,
      statusCallbackUrl: envelope.statusCallbackUrl,
      salonIsTest: envelope.salonIsTest,
      lang: envelope.lang,
    });
  },
  async sendEmail(envelope, context) {
    const resend = getResendClient();
    if (!resend) return { data: null, error: { code: "provider_configuration_invalid" } };
    return resend.emails.send({
      from: envelope.from,
      to: envelope.to,
      subject: envelope.subject,
      html: envelope.html,
      headers: envelope.headers,
      ...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
      ...(envelope.attachments.length ? { attachments: envelope.attachments } : {}),
      tags: [
        { name: "nailiq_flow", value: "customer_booking" },
        { name: "nailiq_claim_kind", value: "confirmation" },
        { name: "nailiq_claim", value: context.claimId },
      ],
    });
  },
  emailSuppressionReason: customerEmailDeliverySuppressionReason,
};

const defaultWorkerDeps: BookingConfirmationRetryWorkerDeps = {
  async reconcile(limit) {
    const { data, error } = await createServiceRoleClient().rpc(
      "reconcile_stale_booking_confirmation_claims" as never,
      { p_limit: limit } as never,
    );
    if (error || !record(data)) return { success: false, reconciled: 0 };
    return { success: data.success === true, reconciled: Number.isSafeInteger(data.reconciled) ? Number(data.reconciled) : 0 };
  },
  async lease(limit) {
    const { data, error } = await createServiceRoleClient().rpc(
      "lease_due_booking_confirmation_retries" as never,
      { p_limit: limit } as never,
    );
    return error || !Array.isArray(data) ? [] : data;
  },
  delivery: defaultDeps,
};
