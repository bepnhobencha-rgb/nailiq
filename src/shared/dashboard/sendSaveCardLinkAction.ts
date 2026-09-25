"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isFrontDeskRole } from "@/shared/lib/salonMemberRole";
import { generateReminderToken } from "@/shared/noshow/generateReminderToken";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { buildSaveCardSms } from "@/shared/lib/smsTemplateRegistry";
import { sendCustomerLinkEmail } from "@/shared/lib/sendCustomerLinkEmail";
import { claimCardRetryEmail, completeCardRetryEmail } from "@/shared/notifications/cardRetryEmailReceipt";

/**
 * Desk-initiated "save a card to hold your spot" link.
 *
 * For a phone-in / walk-up booking by a new or no-show-prone customer, the
 * receptionist taps one button to text the customer a link to a card-capture
 * page (`/booking/save-card?token=…`). The customer saves a card in one tap —
 * NO upfront charge — and is only charged the no-show fee if they don't show.
 * Uses a short-lived, action-scoped card-management capability. SMS flows through the kill-switch
 * chokepoint (sendSmsReminder), like every other outbound message.
 */

const SITE_URL =
  (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";

export type SendSaveCardLinkResult =
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "invalid_booking"
        | "no_phone"
        | "invalid_channel"
        | "no_email"
        | "email_disabled"
        | "email_send_failed"
        | "email_retry_blocked"
        | "trial_outbound_paused"
        | "protection_disabled"
        | "server_error";
    }
  | { ok: true; url: string; smsSent?: boolean; emailSent?: boolean };

export async function sendSaveCardLink(
  slug: string,
  input: { bookingId: string; sendSms?: boolean; channel?: "email_only"; language?: "en" | "vi" },
): Promise<SendSaveCardLinkResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isFrontDeskRole(ctx.role)) return { ok: false, error: "forbidden" };
  if (!ctx.entitlements.canRunMarketing) {
    return { ok: false, error: "trial_outbound_paused" };
  }

  // Explicit email intent never falls back to SMS, even for a forged payload.
  if (input.channel !== undefined && input.channel !== "email_only") {
    return { ok: false, error: "invalid_channel" };
  }
  const emailOnly = input.channel === "email_only";
  if (emailOnly && input.sendSms) return { ok: false, error: "invalid_channel" };

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId) return { ok: false, error: "invalid_booking" };

  // Booking must be in the caller's salon (RLS client). Pull the phone so we
  // can text the link without a second round-trip.
  const { data: bk } = await ctx.supabase
    .from("bookings")
    .select("id, client_phone, client_email, client_name, status, deleted_at, start_time_utc, noshow_card_required, noshow_card_id, card_protection_status")
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (!bk?.id) return { ok: false, error: "invalid_booking" };
  if (emailOnly && (bk.deleted_at || !["pending", "confirmed"].includes(bk.status)
    || !bk.start_time_utc || Date.parse(bk.start_time_utc) <= Date.now()
    || !Number.isFinite(Date.parse(bk.start_time_utc))
    || bk.noshow_card_required !== true || bk.noshow_card_id
    || !["awaiting_card", "retry_required"].includes(bk.card_protection_status ?? ""))) {
    return { ok: false, error: "invalid_booking" };
  }

  // The link only does something if the salon has no-show protection on; fail
  // early with a clear reason rather than texting a dead link.
  const salon = ctx.salon;
  if (!salon.noshow_protection_enabled) {
    return { ok: false, error: "protection_disabled" };
  }

  const email = String(bk.client_email ?? "").trim();
  const emailEnabled =
    (salon as { email_links_enabled?: boolean } | null)?.email_links_enabled !== false;
  // Validate the selected destination before creating a short-lived capability.
  if (emailOnly && !email) return { ok: false, error: "no_email" };
  if (emailOnly && !emailEnabled) return { ok: false, error: "email_disabled" };
  // A receipt is never reclaimed merely because time passed. A crashed process
  // may have sent already; reconciliation must precede any further attempt.
  const emailLease = emailOnly ? await claimCardRetryEmail({
    salonId: salon.id, bookingId, actorId: ctx.userId, email,
  }) : null;
  if (emailOnly && !emailLease) return { ok: false, error: "email_retry_blocked" };

  const token = await generateReminderToken(bookingId, ctx.salon.id, {
    action: "card_manage",
    expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
  });
  if (!token) return { ok: false, error: "server_error" };

  const url = `${SITE_URL}/booking/save-card?token=${token.id}`;

  const salonName = ctx.salon.name?.trim() || "NailIQ";
  const en = input.language === "en";
  const phone = String((bk as { client_phone?: string }).client_phone ?? "").trim();

  let smsSent: boolean | undefined;
  let emailSent: boolean | undefined;

  // Default (fixed) templates — used when the salon hasn't opted into the AI
  // policy agent, or the AI draft is unavailable/unsafe (fail-safe).
  const smsBody = buildSaveCardSms({
    lang: en ? "en" : "vi",
    salonName,
    url,
  });
  let emailBody = en
    ? "Save a card to hold your appointment — there's no upfront charge. You're only charged the no-show fee if you don't show up."
    : "Lưu thẻ để giữ lịch hẹn — không thu phí trước. Bạn chỉ bị tính phí vắng mặt nếu không đến.";

  // AI-personalised wording — only for salons opted into the no-show policy agent
  // (live or shadow). The AI writes in the SEND language (so English guests get
  // English, not the agent's default Vietnamese), and the SMS goes through a
  // deterministic guard (length / no emoji / no stray link / brand). Any failure
  // → keep the fixed templates above. Email can be richer (no SMS constraints).
  const flags = (salon as { feature_flags?: Record<string, unknown> | null } | null)?.feature_flags;
  const aiOptedIn =
    flags?.ai_noshow_policy_live === true || flags?.ai_noshow_policy_shadow === true;
  if (aiOptedIn && !emailOnly) {
    try {
      const { draftSaveCardMessages } = await import(
        "@/shared/noshow/agentNoShowPolicy"
      );
      const drafted = await draftSaveCardMessages({
        salonId: ctx.salon.id,
        lang: en ? "en" : "vi",
        salonName,
        clientName: (bk as { client_name?: string }).client_name ?? null,
      });
      if (drafted) {
        if (drafted.email && drafted.email.length <= 600) emailBody = drafted.email;
      }
    } catch {
      /* keep the fixed templates */
    }
  }

  // The "send link" intent. Deliver on EVERY channel we have — SMS often never
  // reaches US handsets (carrier filtering of link-SMS from unregistered A2P
  // numbers), so email is the parallel/fallback channel, not a nice-to-have.
  if (input.sendSms || emailOnly) {
    const canEmail = emailEnabled && !!email;
    if (!phone && !canEmail) return { ok: false, error: "no_phone" };

    if (phone && !emailOnly) {
      try {
        const r = await sendSmsReminder(phone, smsBody, {
          salonId: ctx.salon.id,
          bookingId,
          notificationType: "save_card_link",
        });
        smsSent = r.ok;
      } catch {
        smsSent = false;
      }
    }

    if (canEmail) {
      try {
      const r = await sendCustomerLinkEmail({
        requireReceipt: emailOnly,
        ...(emailLease ? { idempotencyKey: `card-retry-email/${emailLease.id}` } : {}),
        email,
        clientName: (bk as { client_name?: string }).client_name ?? null,
        salonName,
        salonAddress: (salon as { address?: string | null } | null)?.address ?? null,
        lang: en ? "en" : "vi",
        subject: en
          ? `Save a card to hold your appointment · ${salonName}`
          : `Lưu thẻ để giữ lịch hẹn · ${salonName}`,
        bodyText: emailOnly
          ? en
            ? "Your appointment remains reserved. Please use this secure link to try saving your card again. Saving a card does not charge you. Any applicable fee requires separate authorized review under the salon policy."
            : "Lịch hẹn của bạn vẫn được giữ. Vui lòng dùng liên kết an toàn này để thử lưu thẻ lại. Lưu thẻ không thu tiền. Mọi khoản phí áp dụng phải được người có thẩm quyền xem xét riêng theo chính sách của tiệm."
          : emailBody,
        ctaLabel: en ? "Save a card" : "Lưu thẻ",
        url,
      });
      if (emailLease) {
        const providerId = r.ok ? r.providerMessageId?.trim() || null : null;
        const persisted = await completeCardRetryEmail(emailLease, providerId);
        emailSent = !!providerId && persisted;
      } else {
        emailSent = r.ok;
      }
      } catch {
        emailSent = false;
        if (emailLease) await completeCardRetryEmail(emailLease, null);
      }
    }
  }

  if (emailOnly && !emailSent) return { ok: false, error: "email_send_failed" };

  return { ok: true, url, smsSent, emailSent };
}
