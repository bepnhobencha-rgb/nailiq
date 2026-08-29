"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isFrontDeskRole } from "@/shared/lib/salonMemberRole";
import { generateReminderToken } from "@/shared/noshow/generateReminderToken";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { sendCustomerLinkEmail } from "@/shared/lib/sendCustomerLinkEmail";

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
        | "protection_disabled"
        | "server_error";
    }
  | { ok: true; url: string; smsSent?: boolean; emailSent?: boolean };

export async function sendSaveCardLink(
  slug: string,
  input: { bookingId: string; sendSms?: boolean; language?: "en" | "vi" },
): Promise<SendSaveCardLinkResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isFrontDeskRole(ctx.role)) return { ok: false, error: "forbidden" };

  const bookingId = String(input.bookingId ?? "").trim();
  if (!bookingId) return { ok: false, error: "invalid_booking" };

  // Booking must be in the caller's salon (RLS client). Pull the phone so we
  // can text the link without a second round-trip.
  const { data: bk } = await ctx.supabase
    .from("bookings")
    .select("id, client_phone, client_email, client_name")
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (!bk?.id) return { ok: false, error: "invalid_booking" };

  // The link only does something if the salon has no-show protection on; fail
  // early with a clear reason rather than texting a dead link.
  const salon = ctx.salon;
  if (!salon.noshow_protection_enabled) {
    return { ok: false, error: "protection_disabled" };
  }

  const token = await generateReminderToken(bookingId, ctx.salon.id, {
    action: "card_manage",
    expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
  });
  if (!token) return { ok: false, error: "server_error" };

  const url = `${SITE_URL}/booking/save-card?token=${token.id}`;

  const salonName = ctx.salon.name?.trim() || "NailIQ";
  const en = input.language === "en";
  const phone = String((bk as { client_phone?: string }).client_phone ?? "").trim();
  const email = String((bk as { client_email?: string }).client_email ?? "").trim();
  const emailEnabled =
    (salon as { email_links_enabled?: boolean } | null)?.email_links_enabled !== false;

  let smsSent: boolean | undefined;
  let emailSent: boolean | undefined;

  // Default (fixed) templates — used when the salon hasn't opted into the AI
  // policy agent, or the AI draft is unavailable/unsafe (fail-safe).
  let smsBody = en
    ? `${salonName}: Save a card to hold your appointment — you're only charged if you no-show: ${url}`
    : `${salonName}: Lưu thẻ để giữ lịch hẹn — chỉ bị tính phí nếu bạn không đến: ${url}`;
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
  if (aiOptedIn) {
    try {
      const { draftSaveCardMessages, guardSmsLine } = await import(
        "@/shared/noshow/agentNoShowPolicy"
      );
      const drafted = await draftSaveCardMessages({
        salonId: ctx.salon.id,
        lang: en ? "en" : "vi",
        salonName,
        clientName: (bk as { client_name?: string }).client_name ?? null,
      });
      if (drafted) {
        const guardedSms = drafted.sms ? guardSmsLine(drafted.sms, salonName, url) : null;
        if (guardedSms) smsBody = guardedSms;
        if (drafted.email && drafted.email.length <= 600) emailBody = drafted.email;
      }
    } catch {
      /* keep the fixed templates */
    }
  }

  // The "send link" intent. Deliver on EVERY channel we have — SMS often never
  // reaches US handsets (carrier filtering of link-SMS from unregistered A2P
  // numbers), so email is the parallel/fallback channel, not a nice-to-have.
  if (input.sendSms) {
    const canEmail = emailEnabled && !!email;
    if (!phone && !canEmail) return { ok: false, error: "no_phone" };

    if (phone) {
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
      const r = await sendCustomerLinkEmail({
        email,
        clientName: (bk as { client_name?: string }).client_name ?? null,
        salonName,
        salonAddress: (salon as { address?: string | null } | null)?.address ?? null,
        lang: en ? "en" : "vi",
        subject: en
          ? `Save a card to hold your appointment · ${salonName}`
          : `Lưu thẻ để giữ lịch hẹn · ${salonName}`,
        bodyText: emailBody,
        ctaLabel: en ? "Save a card" : "Lưu thẻ",
        url,
      });
      emailSent = r.ok;
    }
  }

  return { ok: true, url, smsSent, emailSent };
}
