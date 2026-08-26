import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isEmailSuppressed } from "@/shared/lib/emailCompliance";
import { getResendClient } from "@/shared/lib/resend";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import {
  deliverClaimedStaffActionNotification,
  type StaffActionEmailEnvelope,
  type StaffActionNotificationDeliveryDeps,
  type StaffActionSmsEnvelope,
} from "@/shared/notifications/staffActionNotificationDelivery";
import {
  buildStaffActionNotificationEnvelope,
  parseStaffActionNotificationMaterial,
} from "@/shared/notifications/staffActionNotificationEnvelope";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RpcClient = Pick<SupabaseClient, "rpc">;

export type StaffActionNotificationWorkerResult = {
  ok: boolean;
  code: "processed" | "reconciliation_unavailable" | "discovery_unavailable" | "lease_unavailable";
  materialized: number;
  unmaterializableSuppressed: number;
  /** Rows deliberately left in awaiting_material for DB-bounded expiry because
   * no canonical recipient/enabled channel existed. They are never leased. */
  awaitingExpiry: number;
  claimed: number;
  accepted: number;
  rejected: number;
  suppressed: number;
  unknown: number;
  completionUnavailable: number;
  reconciled: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedLimit(value: number): number {
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), 25) : 10;
}

function deliveryIds(value: unknown): string[] | null {
  if (!record(value) || value.success !== true || value.code !== "material_required" ||
      !Array.isArray(value.deliveries) || value.deliveries.length < 1 || value.deliveries.length > 2) return null;
  const result: string[] = [];
  for (const item of value.deliveries) {
    if (!record(item) || !UUID_RE.test(String(item.delivery_id ?? "")) ||
        (item.channel !== "sms" && item.channel !== "email")) return null;
    result.push(String(item.delivery_id));
  }
  return new Set(result).size === result.length ? result : null;
}

function rpcSucceeded(value: unknown, codes: readonly string[]): boolean {
  return record(value) && value.success === true && codes.includes(String(value.code ?? ""));
}

function siteUrl(): string | null {
  const candidate = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

async function sendSms(envelope: StaffActionSmsEnvelope) {
  return sendSmsReminder(envelope.to, envelope.body, {
    salonId: envelope.salonId,
    statusCallbackUrl: envelope.statusCallbackUrl,
    salonIsTest: envelope.salonIsTest,
    lang: envelope.lang,
  });
}

async function sendEmail(envelope: StaffActionEmailEnvelope) {
  let suppressed: boolean;
  try {
    suppressed = await isEmailSuppressed(envelope.to);
  } catch {
    return { data: null, error: { code: "suppression_unavailable", statusCode: 503 } };
  }
  if (suppressed) {
    return {
      data: null,
      error: null,
      suppressed: true,
      suppressionReason: "consent_revoked",
    };
  }
  let client: ReturnType<typeof getResendClient>;
  try {
    client = getResendClient();
  } catch {
    return { data: null, error: { code: "provider_configuration_invalid", statusCode: 503 } };
  }
  if (!client) {
    return { data: null, error: { code: "provider_configuration_invalid", statusCode: 503 } };
  }
  return client.emails.send({
    from: envelope.from,
    to: envelope.to,
    subject: envelope.subject,
    html: envelope.html,
    text: envelope.text,
    headers: envelope.headers,
    ...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
  });
}

export async function runStaffActionNotificationWorker(
  requestedLimit = 10,
  overrides?: {
    client?: RpcClient;
    siteUrl?: string;
    sendSms?: StaffActionNotificationDeliveryDeps["sendSms"];
    sendEmail?: StaffActionNotificationDeliveryDeps["sendEmail"];
  },
): Promise<StaffActionNotificationWorkerResult> {
  const limit = boundedLimit(requestedLimit);
  const client = overrides?.client ?? createServiceRoleClient();
  const counts: StaffActionNotificationWorkerResult = {
    ok: false,
    code: "reconciliation_unavailable",
    materialized: 0,
    unmaterializableSuppressed: 0,
    awaitingExpiry: 0,
    claimed: 0,
    accepted: 0,
    rejected: 0,
    suppressed: 0,
    unknown: 0,
    completionUnavailable: 0,
    reconciled: 0,
  };

  const { data: reconciled, error: reconcileError } = await client.rpc(
    "reconcile_stale_staff_action_notification_deliveries" as never,
    { p_limit: limit } as never,
  );
  if (reconcileError || !rpcSucceeded(reconciled, ["reconciled"])) return counts;
  counts.reconciled = Number((reconciled as Record<string, unknown>).reconciled ?? 0);

  const { data: discovered, error: discoveryError } = await client.rpc(
    "discover_staff_action_notifications_awaiting_material" as never,
    { p_limit: limit } as never,
  );
  if (discoveryError || !Array.isArray(discovered)) {
    counts.code = "discovery_unavailable";
    return counts;
  }
  const configuredSiteUrl = overrides?.siteUrl ?? siteUrl();
  if (discovered.length > 0 && !configuredSiteUrl) {
    counts.code = "discovery_unavailable";
    return counts;
  }
  for (const discoveredRow of discovered) {
    const ids = deliveryIds(discoveredRow);
    if (!ids) continue;
    for (const deliveryId of ids) {
      const { data: rawMaterial, error: materialError } = await client.rpc(
        "load_staff_action_notification_material" as never,
        { p_delivery_id: deliveryId } as never,
      );
      if (materialError) continue;
      const material = parseStaffActionNotificationMaterial(rawMaterial);
      if (!material || !configuredSiteUrl) continue;
      const rendered = buildStaffActionNotificationEnvelope(material, { siteUrl: configuredSiteUrl });
      if (!rendered) {
        const channelEnabled = material.channel === "sms"
          ? material.snapshot.smsOutboundEnabled
          : material.snapshot.emailOutboundEnabled;
        const hasRecipient = material.channel === "sms"
          ? Boolean(material.snapshot.clientPhone)
          : Boolean(material.snapshot.clientEmail);
        const reason = !channelEnabled
          ? "channel_disabled"
          : !hasRecipient
            ? "recipient_missing"
            : null;
        if (reason) {
          const { data: suppressed, error: suppressError } = await client.rpc(
            "suppress_unmaterializable_staff_action_delivery" as never,
            { p_delivery_id: deliveryId, p_reason: reason } as never,
          );
          if (!suppressError && rpcSucceeded(suppressed, ["suppressed", "already_suppressed"])) {
            counts.unmaterializableSuppressed += 1;
            continue;
          }
        }
        // Fail closed on a suppression outage. The DB reconciler still owns a
        // bounded awaiting_material expiry; never fabricate a recipient/send.
        counts.awaitingExpiry += 1;
        continue;
      }
      const { data: materialized, error: materializeError } = await client.rpc(
        "materialize_staff_action_notification_delivery" as never,
        {
          p_delivery_id: deliveryId,
          p_payload_fingerprint: rendered.envelopeFingerprint,
          p_recipient_fingerprint: rendered.recipientFingerprint,
          p_dispatch_envelope: rendered.envelope,
        } as never,
      );
      if (!materializeError && rpcSucceeded(materialized, ["materialized", "already_materialized"])) {
        counts.materialized += 1;
      }
    }
  }

  const { data: leases, error: leaseError } = await client.rpc(
    "lease_due_staff_action_notification_deliveries" as never,
    { p_limit: limit } as never,
  );
  if (leaseError || !Array.isArray(leases)) {
    counts.code = "lease_unavailable";
    return counts;
  }

  const deps: StaffActionNotificationDeliveryDeps = {
    sendSms: overrides?.sendSms ?? sendSms,
    sendEmail: overrides?.sendEmail ?? sendEmail,
    complete: async (input) => {
      const { data, error } = await client.rpc(
        "complete_staff_action_notification_delivery" as never,
        {
          p_delivery_id: input.deliveryId,
          p_attempt_token: input.attemptToken,
          p_status: input.status,
          p_provider_message_id: input.providerMessageId,
          p_error_code: input.errorCode,
          p_failure_disposition: input.failureDisposition,
        } as never,
      );
      return error || !record(data)
        ? { success: false, code: "completion_unavailable" }
        : { success: data.success === true, code: String(data.code ?? "completion_unavailable") };
    },
  };
  for (const lease of leases) {
    const result = await deliverClaimedStaffActionNotification(lease, deps);
    if (result.deliveryId === null) continue;
    counts.claimed += 1;
    counts[result.outcome] += 1;
    if (!result.finalized) counts.completionUnavailable += 1;
  }
  counts.ok = true;
  counts.code = "processed";
  return counts;
}
