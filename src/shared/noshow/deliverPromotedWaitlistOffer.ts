import "server-only";

import { createHash } from "node:crypto";
import { escapeEmailHtml } from "@/shared/booking/emailBranding";
import { isBookingManagementToken } from "@/shared/booking/bookingManagementCapabilities";
import { isValidIanaTimeZone } from "@/shared/booking/bookingManagementTime";
import { isEmailSuppressed } from "@/shared/lib/emailCompliance";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendSmsReminder } from "@/shared/lib/twilioSms";

export type PromotedWaitlistOffer = {
  waitlistEntryId: string;
  claimCapabilityToken: string;
  offerEpoch: number;
};

type Channel = "sms" | "email";

type DeliveryMaterial = {
  materialFingerprint: string;
  recipientFingerprint: string;
  snapshot: {
    salonId: string;
    waitlistEntryId: string;
    offerEpoch: number;
    channel: Channel;
    claimCapabilityId: string;
    salonName: string;
    salonSlug: string;
    salonTimezone: string;
    salonLogoUrl: string | null;
    salonPhone: string | null;
    smsOutboundEnabled: boolean;
    emailOutboundEnabled: boolean;
    locale: "en" | "vi";
    serviceId: string;
    serviceName: string;
    clientName: string;
    recipient: string;
    bookingDate: string;
    offeredStaffId: string | null;
    staffName: string | null;
    offeredStartUtc: string | null;
    offeredEndUtc: string | null;
  };
};

const SHA256_RE = /^[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableText(value: unknown): string | null | undefined {
  return value == null ? null : text(value) ?? undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeRecipient(channel: Channel, value: string): string {
  return channel === "email" ? value.trim().toLowerCase() : value.trim();
}

function parseDeliveryMaterial(
  value: unknown,
  expected: { salonId: string; offer: PromotedWaitlistOffer; channel: Channel },
): DeliveryMaterial | null {
  const row = record(value);
  const snapshot = record(row?.snapshot);
  const materialFingerprint = text(row?.material_fingerprint);
  const recipientFingerprint = text(row?.recipient_fingerprint);
  const salonId = text(snapshot?.salon_id);
  const waitlistEntryId = text(snapshot?.waitlist_entry_id);
  const offerEpoch = snapshot?.offer_epoch;
  const channel = snapshot?.channel;
  const claimCapabilityId = text(snapshot?.claim_capability_id);
  const salonName = text(snapshot?.salon_name);
  const salonSlug = text(snapshot?.salon_slug);
  const salonTimezone = text(snapshot?.salon_timezone);
  const salonLogoUrl = nullableText(snapshot?.salon_logo_url);
  const salonPhone = nullableText(snapshot?.salon_phone);
  const serviceId = text(snapshot?.service_id);
  const serviceName = text(snapshot?.service_name);
  const clientName = text(snapshot?.client_name);
  const recipient = text(snapshot?.recipient);
  const bookingDate = text(snapshot?.booking_date);
  const offeredStaffId = nullableText(snapshot?.offered_staff_id);
  const staffName = nullableText(snapshot?.staff_name);
  const offeredStartUtc = nullableText(snapshot?.offered_start_utc);
  const offeredEndUtc = nullableText(snapshot?.offered_end_utc);
  const locale = snapshot?.locale;

  if (
    row?.ok !== true || row.code !== "material_loaded" || !snapshot ||
    !materialFingerprint || !SHA256_RE.test(materialFingerprint) ||
    !recipientFingerprint || !SHA256_RE.test(recipientFingerprint) ||
    salonId !== expected.salonId || waitlistEntryId !== expected.offer.waitlistEntryId ||
    offerEpoch !== expected.offer.offerEpoch || channel !== expected.channel ||
    claimCapabilityId !== expected.offer.claimCapabilityToken ||
    !isBookingManagementToken(salonId) || !isBookingManagementToken(waitlistEntryId) ||
    !isBookingManagementToken(claimCapabilityId) || !salonName || !salonSlug ||
    !salonTimezone || !isValidIanaTimeZone(salonTimezone) ||
    salonLogoUrl === undefined || salonPhone === undefined ||
    typeof snapshot.sms_outbound_enabled !== "boolean" ||
    typeof snapshot.email_outbound_enabled !== "boolean" ||
    (locale !== "en" && locale !== "vi") || !serviceId ||
    !isBookingManagementToken(serviceId) || !serviceName || !clientName || !recipient ||
    !bookingDate || !/^\d{4}-\d{2}-\d{2}$/.test(bookingDate) ||
    offeredStaffId === undefined || staffName === undefined ||
    (offeredStaffId !== null && !isBookingManagementToken(offeredStaffId)) ||
    ((offeredStaffId === null) !== (staffName === null)) ||
    offeredStartUtc === undefined || offeredEndUtc === undefined ||
    ((offeredStartUtc === null) !== (offeredEndUtc === null)) ||
    (offeredStartUtc !== null && (
      !Number.isFinite(Date.parse(offeredStartUtc)) || !Number.isFinite(Date.parse(offeredEndUtc!)) ||
      Date.parse(offeredEndUtc!) <= Date.parse(offeredStartUtc)
    ))
  ) return null;

  const normalizedRecipient = normalizeRecipient(expected.channel, recipient);
  if (sha256(normalizedRecipient) !== recipientFingerprint) return null;

  return {
    materialFingerprint,
    recipientFingerprint,
    snapshot: {
      salonId,
      waitlistEntryId,
      offerEpoch: expected.offer.offerEpoch,
      channel: expected.channel,
      claimCapabilityId,
      salonName: salonName.slice(0, 160),
      salonSlug: salonSlug.slice(0, 160),
      salonTimezone,
      salonLogoUrl,
      salonPhone,
      smsOutboundEnabled: snapshot.sms_outbound_enabled,
      emailOutboundEnabled: snapshot.email_outbound_enabled,
      locale,
      serviceId,
      serviceName: serviceName.slice(0, 160),
      clientName: clientName.slice(0, 160),
      recipient: normalizedRecipient,
      bookingDate,
      offeredStaffId,
      staffName: staffName?.slice(0, 160) ?? null,
      offeredStartUtc,
      offeredEndUtc,
    },
  };
}

async function loadMaterial(input: {
  salonId: string;
  offer: PromotedWaitlistOffer;
  channel: Channel;
}): Promise<DeliveryMaterial | null> {
  const { data, error } = await createServiceRoleClient().rpc(
    "load_waitlist_offer_delivery_material" as never,
    {
      p_salon_id: input.salonId,
      p_waitlist_entry_id: input.offer.waitlistEntryId,
      p_offer_epoch: input.offer.offerEpoch,
      p_channel: input.channel,
      p_claim_capability_id: input.offer.claimCapabilityToken,
    } as never,
  );
  if (error) return null;
  return parseDeliveryMaterial(data, input);
}

async function complete(input: {
  outboxId: string;
  attemptToken: string;
  status: "sent" | "failed" | "unknown" | "suppressed";
  receipt?: string | null;
  errorCode?: string | null;
}): Promise<void> {
  const { error } = await createServiceRoleClient().rpc(
    "complete_waitlist_offer_delivery" as never,
    {
      p_outbox_id: input.outboxId,
      p_attempt_token: input.attemptToken,
      p_status: input.status,
      p_provider_receipt: input.receipt ?? null,
      p_error_code: input.errorCode ?? null,
    } as never,
  );
  if (error) console.error("[deliverPromotedWaitlistOffer] completion unavailable");
}

async function deliverChannel(input: {
  salonId: string;
  offer: PromotedWaitlistOffer;
  channel: Channel;
}): Promise<void> {
  const material = await loadMaterial(input);
  if (!material) return;
  const snapshot = material.snapshot;
  const claimUrl = `${(process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca").replace(/\/$/, "")}/booking/waitlist-claim?token=${encodeURIComponent(snapshot.claimCapabilityId)}`;
  const offeredTime = snapshot.offeredStartUtc
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: snapshot.salonTimezone,
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(snapshot.offeredStartUtc))
    : null;
  const detail = [snapshot.bookingDate, offeredTime, snapshot.staffName].filter(Boolean).join(" · ");
  const textBody = snapshot.locale === "vi"
    ? `${snapshot.salonName}: Có chỗ trống cho ${snapshot.serviceName}${detail ? ` (${detail})` : ""}. Giữ chỗ trong 20 phút: ${claimUrl}`
    : `${snapshot.salonName}: A ${snapshot.serviceName} opening is available${detail ? ` (${detail})` : ""}. Claim it within 20 minutes: ${claimUrl}`;
  const subject = snapshot.locale === "vi"
    ? `Có chỗ trống tại ${snapshot.salonName}`
    : `An appointment opened at ${snapshot.salonName}`;
  const html = `<p>${escapeEmailHtml(textBody)}</p><p><a href="${escapeEmailHtml(claimUrl)}">${snapshot.locale === "vi" ? "Giữ chỗ" : "Claim this time"}</a></p>`;
  const payloadFingerprint = sha256(JSON.stringify({
    v: 1,
    channel: input.channel,
    to: snapshot.recipient,
    subject,
    text: textBody,
    html,
  }));

  const { data, error } = await createServiceRoleClient().rpc(
    "claim_waitlist_offer_delivery" as never,
    {
      p_salon_id: snapshot.salonId,
      p_waitlist_entry_id: snapshot.waitlistEntryId,
      p_offer_epoch: snapshot.offerEpoch,
      p_channel: snapshot.channel,
      p_claim_capability_id: snapshot.claimCapabilityId,
      p_recipient_fingerprint: material.recipientFingerprint,
      p_material_fingerprint: material.materialFingerprint,
      p_payload_fingerprint: payloadFingerprint,
    } as never,
  );
  if (error) return;
  const claim = record(data);
  const outboxId = text(claim?.outbox_id);
  const attemptToken = text(claim?.attempt_token);
  if (!claim || claim.ok !== true || claim.code !== "claimed" || !outboxId || !attemptToken ||
      !isBookingManagementToken(outboxId) || !isBookingManagementToken(attemptToken)) return;

  const outboundEnabled = input.channel === "sms"
    ? snapshot.smsOutboundEnabled
    : snapshot.emailOutboundEnabled;
  if (!outboundEnabled) {
    await complete({ outboxId, attemptToken, status: "suppressed", errorCode: "channel_disabled" });
    return;
  }
  if (input.channel === "email" && await isEmailSuppressed(snapshot.recipient)) {
    await complete({ outboxId, attemptToken, status: "suppressed", errorCode: "recipient_suppressed" });
    return;
  }

  try {
    if (input.channel === "sms") {
      const result = await sendSmsReminder(snapshot.recipient, textBody, {
        salonId: snapshot.salonId,
        lang: snapshot.locale,
      });
      if (result.suppressed) {
        await complete({
          outboxId,
          attemptToken,
          status: "suppressed",
          errorCode: result.suppressionReason ?? "recipient_suppressed",
        });
        return;
      }
      const receipt = result.messageSid?.trim() ?? "";
      if (result.ok && /^(SM|MM)[0-9a-fA-F]{32}$/.test(receipt)) {
        await complete({ outboxId, attemptToken, status: "sent", receipt });
      } else if (result.ok) {
        await complete({ outboxId, attemptToken, status: "unknown", errorCode: "invalid_provider_receipt" });
      } else {
        await complete({ outboxId, attemptToken, status: "failed", errorCode: "provider_rejected" });
      }
      return;
    }

    const resend = getResendClient();
    if (!resend) {
      await complete({ outboxId, attemptToken, status: "failed", errorCode: "provider_configuration_invalid" });
      return;
    }
    const result = await resend.emails.send({
      from: getResendFrom(),
      to: snapshot.recipient,
      subject,
      text: textBody,
      html,
    });
    const receipt = result.data?.id?.trim() ?? "";
    if (result.error) {
      await complete({ outboxId, attemptToken, status: "failed", errorCode: "provider_rejected" });
    } else if (!receipt) {
      await complete({ outboxId, attemptToken, status: "unknown", errorCode: "invalid_provider_receipt" });
    } else {
      await complete({ outboxId, attemptToken, status: "sent", receipt });
    }
  } catch {
    await complete({ outboxId, attemptToken, status: "unknown", errorCode: "provider_exception" });
  }
}

export async function deliverPromotedWaitlistOffer(input: {
  salonId: string;
  offer: PromotedWaitlistOffer;
}): Promise<void> {
  if (!isBookingManagementToken(input.salonId) ||
      !isBookingManagementToken(input.offer.waitlistEntryId) ||
      !isBookingManagementToken(input.offer.claimCapabilityToken) ||
      !Number.isSafeInteger(input.offer.offerEpoch) || input.offer.offerEpoch < 1) return;
  await Promise.all([
    deliverChannel({ ...input, channel: "sms" }),
    deliverChannel({ ...input, channel: "email" }),
  ]);
}
