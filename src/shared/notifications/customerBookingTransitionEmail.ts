import "server-only";

import { createHash } from "node:crypto";
import { buildEmailBrandHeader, escapeEmailHtml } from "@/shared/booking/emailBranding";
import { complianceFooterHtml, listUnsubscribeHeaders } from "@/shared/lib/emailCompliance";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { buildStaffActionEmailSubject, buildStaffActionSms } from "./staffActionMessages";
import { customerEmailDeliverySuppressionReason } from "./customerEmailDeliverySuppression";

export type CustomerBookingTransitionKind = "cancel" | "reschedule";

export type CustomerBookingTransitionIdentity = {
  salonId: string;
  bookingId: string;
  transitionKind: CustomerBookingTransitionKind;
  expectedTransitionVersion: number;
};

export type CustomerBookingTransitionSnapshot = {
  recipientEmail: string;
  locale: "en" | "vi";
  clientName: string;
  serviceId: string;
  serviceName: string;
  staffId: string | null;
  staffName: string;
  salonName: string;
  salonSlug: string;
  salonTimezone: string;
  salonLogoUrl: string | null;
  salonPhone: string | null;
  previousStatus: string;
  currentStatus: string;
  previousStartTimeUtc: string;
  newStartTimeUtc: string;
  transitionedAt: string;
};

export type CustomerBookingTransitionMaterial = {
  outboxId: string;
  eventType: string;
  transitionVersion: number;
  occurrenceKey: string;
  status: string;
  recipientFingerprint: string;
  materialFingerprint: string;
  payloadFingerprint: string | null;
  snapshot: CustomerBookingTransitionSnapshot;
};

export type CustomerBookingTransitionEmailPayload = {
  v: 1;
  eventType: string;
  occurrenceKey: string;
  to: string;
  locale: "en" | "vi";
  subject: string;
  text: string;
  html: string;
};

type ProviderResponse = {
  data?: { id?: string | null } | null;
  error?: {
    message?: unknown;
    name?: unknown;
    statusCode?: unknown;
  } | null;
};

type Provider = {
  send(input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    headers: Record<string, string>;
    tags: Array<{ name: string; value: string }>;
  }): Promise<ProviderResponse>;
};

type ClaimedTransition = CustomerBookingTransitionMaterial & {
  attemptToken: string;
  attemptCount: number;
};

export type CustomerBookingTransitionEmailDeps = {
  loadMaterial(input: CustomerBookingTransitionIdentity): Promise<CustomerBookingTransitionMaterial | null>;
  claim(input: CustomerBookingTransitionIdentity & {
    payloadFingerprint: string;
    recipientFingerprint: string;
  }): Promise<{ code: string; claimed: boolean; material: ClaimedTransition | null }>;
  complete(input: {
    outboxId: string;
    attemptToken: string;
    status: "sent" | "failed" | "unknown" | "suppressed";
    providerMessageId: string | null;
    errorCode: string | null;
    failureDisposition: string | null;
  }): Promise<{ success: boolean; code: string }>;
  provider(): Provider | null;
  from(): string;
  emailSuppressionReason(input: { salonId: string; email: string }): Promise<string | null>;
};

export type CustomerBookingTransitionEmailResult = {
  outcome: "sent" | "failed" | "unknown" | "suppressed";
  reason: string;
  providerId: string | null;
  finalized: boolean;
  transitionVersion: number | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max && !/[\u0000\r\n]/.test(normalized)
    ? normalized
    : null;
}

function nullableText(value: unknown, max = 500): string | null | undefined {
  if (value === null || value === undefined) return null;
  return text(value, max) ?? undefined;
}

function finiteVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function isoInstant(value: unknown): string | null {
  const candidate = text(value, 80);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function normalizeEmail(value: unknown): string | null {
  const candidate = text(value, 320)?.toLowerCase() ?? null;
  if (!candidate || !candidate.includes("@") || /[\r\n]/.test(candidate)) return null;
  return candidate;
}

function parseSnapshot(value: unknown): CustomerBookingTransitionSnapshot | null {
  if (!record(value)) return null;
  const recipientEmail = normalizeEmail(value.recipient_email);
  const locale = value.locale === "vi" ? "vi" : value.locale === "en" ? "en" : null;
  const clientName = text(value.client_name, 200) ?? "";
  const serviceId = text(value.service_id, 80);
  const serviceName = text(value.service_name, 300);
  const staffId = nullableText(value.staff_id, 80);
  const staffName = text(value.staff_name, 300) ?? "";
  const salonName = text(value.salon_name, 300);
  const salonSlug = text(value.salon_slug, 200);
  const salonTimezone = text(value.salon_timezone, 100);
  const salonLogoUrl = nullableText(value.salon_logo_url, 2_048);
  const salonPhone = nullableText(value.salon_phone, 80);
  const previousStatus = text(value.previous_status, 80);
  const currentStatus = text(value.current_status, 80);
  const previousStartTimeUtc = isoInstant(value.previous_start_time_utc);
  const newStartTimeUtc = isoInstant(value.new_start_time_utc);
  const transitionedAt = isoInstant(value.transitioned_at);
  if (
    !recipientEmail || !locale || !serviceId || !UUID_RE.test(serviceId) || !serviceName ||
    staffId === undefined || (staffId !== null && !UUID_RE.test(staffId)) ||
    !salonName || !salonSlug || !salonTimezone || salonLogoUrl === undefined ||
    salonPhone === undefined || !previousStatus || !currentStatus ||
    !previousStartTimeUtc || !newStartTimeUtc || !transitionedAt
  ) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: salonTimezone }).format(new Date(0));
  } catch {
    return null;
  }
  return {
    recipientEmail,
    locale,
    clientName,
    serviceId,
    serviceName,
    staffId,
    staffName,
    salonName,
    salonSlug,
    salonTimezone,
    salonLogoUrl,
    salonPhone,
    previousStatus,
    currentStatus,
    previousStartTimeUtc,
    newStartTimeUtc,
    transitionedAt,
  };
}

function parseMaterial(value: unknown): CustomerBookingTransitionMaterial | null {
  if (!record(value) || value.success !== true) return null;
  const outboxId = text(value.outbox_id, 80);
  const eventType = text(value.event_type, 100);
  const transitionVersion = finiteVersion(value.transition_version);
  const occurrenceKey = text(value.occurrence_key, 200);
  const status = text(value.status, 80);
  const recipientFingerprint = text(value.recipient_fingerprint, 64);
  const materialFingerprint = text(value.material_fingerprint, 64);
  const payloadFingerprint = value.payload_fingerprint === null
    ? null
    : text(value.payload_fingerprint, 64);
  const snapshot = parseSnapshot(value.snapshot);
  if (!outboxId || !UUID_RE.test(outboxId) ||
      (eventType !== "cancel" && eventType !== "reschedule") ||
      !transitionVersion || !occurrenceKey || !/^[0-9a-f]{64}$/.test(occurrenceKey) ||
      !status || !recipientFingerprint || !/^[0-9a-f]{64}$/.test(recipientFingerprint) ||
      !materialFingerprint || !/^[0-9a-f]{64}$/.test(materialFingerprint) ||
      payloadFingerprint === undefined ||
      (payloadFingerprint !== null && !/^[0-9a-f]{64}$/.test(payloadFingerprint)) ||
      !snapshot) return null;
  return {
    outboxId,
    eventType,
    transitionVersion,
    occurrenceKey,
    status,
    recipientFingerprint,
    materialFingerprint,
    payloadFingerprint,
    snapshot,
  };
}

function parseClaim(value: unknown): { code: string; claimed: boolean; material: ClaimedTransition | null } {
  if (!record(value)) return { code: "claim_unavailable", claimed: false, material: null };
  const code = text(value.code, 100) ?? "claim_unavailable";
  if (value.success !== true || value.claimed !== true) return { code, claimed: false, material: null };
  const material = parseMaterial({ ...value, success: true });
  const attemptToken = text(value.attempt_token, 80);
  const attemptCount = finiteVersion(value.attempt_count);
  if (!material || !attemptToken || !UUID_RE.test(attemptToken) || !attemptCount || attemptCount > 2) {
    return { code: "invalid_claim_material", claimed: false, material: null };
  }
  return { code, claimed: true, material: { ...material, attemptToken, attemptCount } };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function customerBookingTransitionRecipientFingerprint(email: string): string {
  return hash(email.trim().toLowerCase());
}

export function customerBookingTransitionPayloadFingerprint(payload: CustomerBookingTransitionEmailPayload): string {
  return hash(JSON.stringify(payload));
}

function whenLabel(value: string, timezone: string, locale: "en" | "vi"): string {
  return new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-CA", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
  }).format(new Date(value));
}

export function buildCustomerBookingTransitionEmailPayload(
  kind: CustomerBookingTransitionKind,
  material: CustomerBookingTransitionMaterial,
): CustomerBookingTransitionEmailPayload | null {
  const snapshot = material.snapshot;
  const appointmentTime = kind === "reschedule"
    ? snapshot.newStartTimeUtc
    : snapshot.previousStartTimeUtc;
  const event = kind === "reschedule" ? "reschedule" : "cancel";
  const subject = buildStaffActionEmailSubject(event, snapshot.locale, snapshot.salonName);
  const messageVars = {
    customerName: snapshot.clientName,
    salonName: snapshot.salonName,
    serviceName: snapshot.serviceName,
    staffName: snapshot.staffName,
    salonPhone: snapshot.salonPhone,
    whenLabel: whenLabel(appointmentTime, snapshot.salonTimezone, snapshot.locale),
  };
  const oldWhen = whenLabel(
    snapshot.previousStartTimeUtc,
    snapshot.salonTimezone,
    snapshot.locale,
  );
  const callLine = snapshot.salonPhone
    ? snapshot.locale === "vi"
      ? ` Cần hỗ trợ? Gọi ${snapshot.salonPhone}.`
      : ` Questions? Call ${snapshot.salonPhone}.`
    : "";
  const greeting = snapshot.clientName
    ? snapshot.locale === "vi" ? `Chào ${snapshot.clientName}, ` : `Hi ${snapshot.clientName}, `
    : "";
  const body = kind === "reschedule"
    ? snapshot.locale === "vi"
      ? `${greeting}lịch hẹn ${snapshot.serviceName} của bạn tại ${snapshot.salonName} đã được dời từ ${oldWhen} sang ${messageVars.whenLabel}.${callLine}`
      : `${greeting}your ${snapshot.serviceName} appointment at ${snapshot.salonName} has been moved from ${oldWhen} to ${messageVars.whenLabel}.${callLine}`
    : buildStaffActionSms(event, snapshot.locale, messageVars);
  if (!subject || !body) return null;
  const subtitle = snapshot.locale === "vi"
    ? kind === "reschedule" ? "Lịch hẹn đã được dời" : "Lịch hẹn đã huỷ"
    : kind === "reschedule" ? "Appointment Rescheduled" : "Appointment Cancelled";
  const html = `<!doctype html><html lang="${snapshot.locale}"><body style="margin:0;padding:0;background:#faf9f7;">
  <main style="max-width:480px;margin:0 auto;padding:28px 22px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#2a2a2a;">
    <div style="padding:16px;background:#0B0C10;text-align:center;border-radius:8px;margin:0 0 18px;">
      ${buildEmailBrandHeader({ salonName: snapshot.salonName, logoUrl: snapshot.salonLogoUrl, subtitle })}
    </div>
    <h1 style="margin:0 0 18px;font-size:18px;font-weight:600;color:#1a1a1a;">${escapeEmailHtml(subject)}</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#333;">${escapeEmailHtml(body)}</p>
  </main>
  ${complianceFooterHtml({ email: snapshot.recipientEmail, salonName: snapshot.salonName, lang: snapshot.locale })}
</body></html>`;
  return {
    v: 1,
    eventType: material.eventType,
    occurrenceKey: material.occurrenceKey,
    to: snapshot.recipientEmail,
    locale: snapshot.locale,
    subject,
    text: body,
    html,
  };
}

function sameMaterial(left: CustomerBookingTransitionMaterial, right: CustomerBookingTransitionMaterial): boolean {
  return left.outboxId === right.outboxId &&
    left.eventType === right.eventType &&
    left.transitionVersion === right.transitionVersion &&
    left.occurrenceKey === right.occurrenceKey &&
    left.recipientFingerprint === right.recipientFingerprint &&
    left.materialFingerprint === right.materialFingerprint &&
    JSON.stringify(left.snapshot) === JSON.stringify(right.snapshot);
}

function validIdentity(input: CustomerBookingTransitionIdentity): boolean {
  return UUID_RE.test(input.salonId) && UUID_RE.test(input.bookingId) &&
    finiteVersion(input.expectedTransitionVersion) !== null &&
    (input.transitionKind === "cancel" || input.transitionKind === "reschedule");
}

function nonblankProviderId(value: unknown): string | null {
  const candidate = text(value, 255);
  return candidate && /^[\x20-\x7e]+$/.test(candidate) ? candidate : null;
}

async function completeWithoutSend(
  material: ClaimedTransition,
  deps: CustomerBookingTransitionEmailDeps,
  errorCode: "material_changed" | "transition_superseded",
): Promise<CustomerBookingTransitionEmailResult> {
  let completion = { success: false, code: "completion_unavailable" };
  try {
    completion = await deps.complete({
      outboxId: material.outboxId,
      attemptToken: material.attemptToken,
      status: "suppressed",
      providerMessageId: null,
      errorCode,
      failureDisposition: "permanent",
    });
  } catch {
    // No provider was contacted; a later reconciler may safely resolve this claim.
  }
  const finalized = completion.success === true || completion.code === "already_completed";
  return {
    outcome: "suppressed",
    reason: finalized ? errorCode : "completion_unavailable",
    providerId: null,
    finalized,
    transitionVersion: material.transitionVersion,
  };
}

async function sendClaimedTransition(
  payload: CustomerBookingTransitionEmailPayload,
  material: ClaimedTransition,
  salonId: string,
  deps: CustomerBookingTransitionEmailDeps,
): Promise<CustomerBookingTransitionEmailResult> {
  let status: "sent" | "failed" | "unknown" = "unknown";
  let providerId: string | null = null;
  let errorCode: string | null = "email_delivery_ambiguous";
  let failureDisposition: string | null = "none";
  let provider: Provider | null = null;
  let suppressionReason: string | null = null;
  try {
    suppressionReason = await deps.emailSuppressionReason({
      salonId,
      email: payload.to,
    });
  } catch {
    suppressionReason = "suppression_lookup_unavailable";
  }
  if (suppressionReason) {
    let completion = { success: false, code: "completion_unavailable" };
    try {
      completion = await deps.complete({
        outboxId: material.outboxId,
        attemptToken: material.attemptToken,
        status: "suppressed",
        providerMessageId: null,
        errorCode: "channel_disabled",
        failureDisposition: "permanent",
      });
    } catch {
      // No provider call occurred; the durable outbox remains the authority.
    }
    const finalized = completion.success === true || completion.code === "already_completed";
    return {
      outcome: "suppressed",
      reason: finalized ? suppressionReason : "completion_unavailable",
      providerId: null,
      finalized,
      transitionVersion: material.transitionVersion,
    };
  }
  try {
    provider = deps.provider();
  } catch {
    provider = null;
  }
  if (!provider) {
    status = "failed";
    errorCode = "provider_configuration_invalid";
    failureDisposition = "permanent";
  } else {
    try {
      const response = await provider.send({
        from: deps.from(),
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        headers: listUnsubscribeHeaders(payload.to),
        tags: [
          { name: "nailiq_flow", value: "customer_booking" },
          { name: "nailiq_claim_kind", value: "transition" },
          { name: "nailiq_claim", value: material.outboxId },
        ],
      });
      providerId = nonblankProviderId(response.data?.id);
      if (response.error && providerId) {
        status = "unknown";
        errorCode = "email_delivery_ambiguous";
        failureDisposition = "none";
        providerId = null;
      } else if (response.error) {
        status = "failed";
        const statusCode = Number(response.error.statusCode);
        const code = statusCode === 429
          ? "email_rate_limited_pre_acceptance"
          : statusCode === 401 || statusCode === 403
            ? "provider_auth_invalid"
            : "email_rejected_pre_acceptance";
        errorCode = code;
        failureDisposition = code === "email_rate_limited_pre_acceptance"
          ? "retryable_pre_acceptance"
          : "permanent";
        providerId = null;
      } else if (providerId) {
        status = "sent";
        errorCode = null;
        failureDisposition = "none";
      } else {
        status = "unknown";
        errorCode = "invalid_provider_receipt";
        failureDisposition = "none";
      }
    } catch {
      status = "unknown";
      providerId = null;
      errorCode = "provider_exception";
      failureDisposition = "none";
    }
  }

  let completion = { success: false, code: "completion_unavailable" };
  try {
    completion = await deps.complete({
      outboxId: material.outboxId,
      attemptToken: material.attemptToken,
      status,
      providerMessageId: providerId,
      errorCode,
      failureDisposition,
    });
  } catch {
    // A lost completion response must never reopen the provider boundary.
  }
  const finalized = completion.success === true || completion.code === "already_completed";
  return {
    outcome: status,
    reason: finalized ? (status === "sent" ? "provider_accepted" : errorCode ?? status) : "completion_unavailable",
    providerId,
    finalized,
    transitionVersion: material.transitionVersion,
  };
}

export async function deliverCustomerBookingTransitionEmail(
  input: CustomerBookingTransitionIdentity,
  deps: CustomerBookingTransitionEmailDeps = defaultDeps,
): Promise<CustomerBookingTransitionEmailResult> {
  if (!validIdentity(input)) {
    return { outcome: "suppressed", reason: "invalid_identity", providerId: null, finalized: false, transitionVersion: null };
  }
  let material: CustomerBookingTransitionMaterial | null = null;
  try {
    material = await deps.loadMaterial(input);
  } catch {
    material = null;
  }
  if (!material || material.transitionVersion !== input.expectedTransitionVersion) {
    return { outcome: "suppressed", reason: "authoritative_material_unavailable", providerId: null, finalized: false, transitionVersion: null };
  }
  if (material.eventType !== input.transitionKind) {
    return { outcome: "suppressed", reason: "transition_kind_mismatch", providerId: null, finalized: false, transitionVersion: material.transitionVersion };
  }
  const payload = buildCustomerBookingTransitionEmailPayload(input.transitionKind, material);
  if (!payload) {
    return { outcome: "suppressed", reason: "invalid_authoritative_material", providerId: null, finalized: false, transitionVersion: material.transitionVersion };
  }
  const payloadFingerprint = customerBookingTransitionPayloadFingerprint(payload);
  const recipientFingerprint = customerBookingTransitionRecipientFingerprint(payload.to);
  if (material.recipientFingerprint !== recipientFingerprint) {
    return { outcome: "suppressed", reason: "recipient_material_mismatch", providerId: null, finalized: false, transitionVersion: material.transitionVersion };
  }
  let claim: Awaited<ReturnType<CustomerBookingTransitionEmailDeps["claim"]>>;
  try {
    claim = await deps.claim({
      ...input,
      payloadFingerprint,
      recipientFingerprint,
    });
  } catch {
    claim = { code: "claim_unavailable", claimed: false, material: null };
  }
  if (!claim.claimed || !claim.material) {
    return { outcome: "suppressed", reason: claim.code, providerId: null, finalized: false, transitionVersion: material.transitionVersion };
  }
  if (!sameMaterial(material, claim.material)) {
    return { outcome: "suppressed", reason: "claim_material_mismatch", providerId: null, finalized: false, transitionVersion: material.transitionVersion };
  }
  if (claim.material.payloadFingerprint !== payloadFingerprint) {
    return { outcome: "suppressed", reason: "claim_payload_mismatch", providerId: null, finalized: false, transitionVersion: material.transitionVersion };
  }

  return sendClaimedTransition(payload, claim.material, input.salonId, deps);
}

function parseLeasedMaterial(value: unknown): ClaimedTransition | null {
  const material = parseMaterial(value);
  if (!material || !record(value) || value.code !== "leased") return null;
  const attemptToken = text(value.attempt_token, 80);
  const attemptCount = finiteVersion(value.attempt_count);
  if (!attemptToken || !UUID_RE.test(attemptToken) || !attemptCount || attemptCount > 2 || !material.payloadFingerprint) return null;
  return { ...material, attemptToken, attemptCount };
}

export async function deliverLeasedCustomerBookingTransitionEmailRetry(
  rawLease: unknown,
  deps: CustomerBookingTransitionEmailDeps = defaultDeps,
): Promise<CustomerBookingTransitionEmailResult> {
  const material = parseLeasedMaterial(rawLease);
  if (!material) {
    return { outcome: "suppressed", reason: "invalid_retry_lease", providerId: null, finalized: false, transitionVersion: null };
  }
  if (material.eventType !== "cancel" && material.eventType !== "reschedule") {
    return completeWithoutSend(material, deps, "material_changed");
  }
  const payload = buildCustomerBookingTransitionEmailPayload(material.eventType, material);
  if (!payload) return completeWithoutSend(material, deps, "material_changed");
  const payloadFingerprint = customerBookingTransitionPayloadFingerprint(payload);
  const recipientFingerprint = customerBookingTransitionRecipientFingerprint(payload.to);
  if (
    material.payloadFingerprint !== payloadFingerprint ||
    material.recipientFingerprint !== recipientFingerprint
  ) {
    return completeWithoutSend(material, deps, "material_changed");
  }
  const salonId = record(rawLease) && typeof rawLease.salon_id === "string"
    ? rawLease.salon_id
    : "";
  if (!UUID_RE.test(salonId)) return completeWithoutSend(material, deps, "material_changed");
  return sendClaimedTransition(payload, material, salonId, deps);
}

export type CustomerBookingTransitionEmailWorkerDeps = {
  reconcileStale(limit: number): Promise<{ success: boolean; reconciled: number }>;
  discoverDue(limit: number): Promise<unknown[]>;
  leaseRetries(limit: number): Promise<unknown[]>;
  email: CustomerBookingTransitionEmailDeps;
};

export type CustomerBookingTransitionEmailWorkerResult = {
  staleReconciled: number;
  initialProcessed: number;
  retriesProcessed: number;
  sent: number;
  failed: number;
  unknown: number;
  suppressed: number;
};

export async function runCustomerBookingTransitionEmailWorker(
  limit = 50,
  deps: CustomerBookingTransitionEmailWorkerDeps = defaultWorkerDeps,
): Promise<CustomerBookingTransitionEmailWorkerResult> {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
  let reconciled = { success: false, reconciled: 0 };
  let discovered: unknown[] = [];
  let leases: unknown[] = [];
  try {
    reconciled = await deps.reconcileStale(boundedLimit);
  } catch {
    // Continue safe pending work; stale sending is never leased or resent.
  }
  try {
    discovered = await deps.discoverDue(boundedLimit);
  } catch {
    discovered = [];
  }
  try {
    leases = await deps.leaseRetries(boundedLimit);
  } catch {
    leases = [];
  }

  const results: CustomerBookingTransitionEmailResult[] = [];
  for (const raw of discovered) {
    const material = parseMaterial(raw);
    if (!material || (material.eventType !== "cancel" && material.eventType !== "reschedule")) continue;
    results.push(await deliverCustomerBookingTransitionEmail({
      salonId: record(raw) && typeof raw.salon_id === "string" ? raw.salon_id : "",
      bookingId: record(raw) && typeof raw.booking_id === "string" ? raw.booking_id : "",
      transitionKind: material.eventType,
      expectedTransitionVersion: material.transitionVersion,
    }, deps.email));
  }
  const initialProcessed = results.length;
  for (const lease of leases) {
    results.push(await deliverLeasedCustomerBookingTransitionEmailRetry(lease, deps.email));
  }
  return {
    staleReconciled: reconciled.success ? reconciled.reconciled : 0,
    initialProcessed,
    retriesProcessed: results.length - initialProcessed,
    sent: results.filter((result) => result.outcome === "sent").length,
    failed: results.filter((result) => result.outcome === "failed").length,
    unknown: results.filter((result) => result.outcome === "unknown").length,
    suppressed: results.filter((result) => result.outcome === "suppressed").length,
  };
}

const defaultDeps: CustomerBookingTransitionEmailDeps = {
  async loadMaterial(input) {
    const { data, error } = await createServiceRoleClient().rpc(
      "load_customer_booking_transition_email_material" as never,
      {
        p_salon_id: input.salonId,
        p_booking_id: input.bookingId,
        p_transition_kind: input.transitionKind,
        p_expected_transition_version: input.expectedTransitionVersion,
      } as never,
    );
    if (error) return null;
    return parseMaterial(data);
  },
  async claim(input) {
    const { data, error } = await createServiceRoleClient().rpc(
      "claim_customer_booking_transition_email" as never,
      {
        p_salon_id: input.salonId,
        p_booking_id: input.bookingId,
        p_transition_kind: input.transitionKind,
        p_expected_transition_version: input.expectedTransitionVersion,
        p_payload_fingerprint: input.payloadFingerprint,
        p_recipient_fingerprint: input.recipientFingerprint,
      } as never,
    );
    return error ? { code: "claim_unavailable", claimed: false, material: null } : parseClaim(data);
  },
  async complete(input) {
    const { data, error } = await createServiceRoleClient().rpc(
      "complete_customer_booking_transition_email" as never,
      {
        p_outbox_id: input.outboxId,
        p_attempt_token: input.attemptToken,
        p_status: input.status,
        p_provider_message_id: input.providerMessageId,
        p_error_code: input.errorCode,
        p_failure_disposition: input.failureDisposition,
      } as never,
    );
    if (error || !record(data)) return { success: false, code: "completion_unavailable" };
    return { success: data.success === true, code: text(data.code, 100) ?? "completion_unavailable" };
  },
  provider() {
    const client = getResendClient();
    if (!client) return null;
    return { send: (payload) => client.emails.send(payload) as Promise<ProviderResponse> };
  },
  from: getResendFrom,
  emailSuppressionReason: customerEmailDeliverySuppressionReason,
};

const defaultWorkerDeps: CustomerBookingTransitionEmailWorkerDeps = {
  async reconcileStale(limit) {
    const { data, error } = await createServiceRoleClient().rpc(
      "reconcile_stale_customer_booking_transition_email_claims" as never,
      { p_limit: limit } as never,
    );
    if (error || !record(data)) return { success: false, reconciled: 0 };
    return {
      success: data.success === true,
      reconciled: typeof data.reconciled === "number" && Number.isSafeInteger(data.reconciled)
        ? data.reconciled
        : 0,
    };
  },
  async discoverDue(limit) {
    const { data, error } = await createServiceRoleClient().rpc(
      "discover_due_customer_booking_transition_emails" as never,
      { p_limit: limit } as never,
    );
    return error || !Array.isArray(data) ? [] : data;
  },
  async leaseRetries(limit) {
    const { data, error } = await createServiceRoleClient().rpc(
      "lease_due_customer_booking_transition_email_retries" as never,
      { p_limit: limit } as never,
    );
    return error || !Array.isArray(data) ? [] : data;
  },
  email: defaultDeps,
};
