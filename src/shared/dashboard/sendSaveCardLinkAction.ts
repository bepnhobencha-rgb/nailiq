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
 * Reuses the same booking_reminder_tokens system as the self-serve
 * reschedule/cancel/manage-card links. SMS flows through the kill-switch
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
  const { data: salon } = await ctx.supabase
    .from("salons")
    .select("noshow_protection_enabled, email_links_enabled, address")
    .eq("id", ctx.salon.id)
    .maybeSingle();
  if (!(salon as { noshow_protection_enabled?: boolean } | null)?.noshow_protection_enabled) {
    return { ok: false, error: "protection_disabled" };
  }

  const token = await generateReminderToken(bookingId, ctx.salon.id);
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

  // The "send link" intent. Deliver on EVERY channel we have — SMS often never
  // reaches US handsets (carrier filtering of link-SMS from unregistered A2P
  // numbers), so email is the parallel/fallback channel, not a nice-to-have.
  if (input.sendSms) {
    const canEmail = emailEnabled && !!email;
    if (!phone && !canEmail) return { ok: false, error: "no_phone" };

    if (phone) {
      const body = en
        ? `${salonName}: Save a card to hold your appointment — you're only charged if you no-show: ${url}`
        : `${salonName}: Lưu thẻ để giữ lịch hẹn — chỉ bị tính phí nếu bạn không đến: ${url}`;
      try {
        const r = await sendSmsReminder(phone, body);
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
        bodyText: en
          ? "Save a card to hold your appointment — there's no upfront charge. You're only charged the no-show fee if you don't show up."
          : "Lưu thẻ để giữ lịch hẹn — không thu phí trước. Bạn chỉ bị tính phí vắng mặt nếu không đến.",
        ctaLabel: en ? "Save a card" : "Lưu thẻ",
        url,
      });
      emailSent = r.ok;
    }
  }

  return { ok: true, url, smsSent, emailSent };
}
