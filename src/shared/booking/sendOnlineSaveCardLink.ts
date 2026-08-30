import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { generateReminderToken } from "@/shared/noshow/generateReminderToken";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { sendCustomerLinkEmail } from "@/shared/lib/sendCustomerLinkEmail";

const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";

/**
 * ONLINE counterpart of the desk `sendSaveCardLink`. The public booking flow
 * captures a card INLINE in the browser — but when the no-show card requirement
 * is decided AFTER the booking (the AI policy agent / evaluateBookingNoShow runs
 * as a side-effect) the customer has usually already left the page, so they were
 * never reached. This texts/emails the AI-drafted save-card link in the
 * customer's language, so the loop closes without a receptionist chasing them.
 *
 * Strictly gated + idempotent-friendly:
 *  - only when noshow_card_required is true AND no card is on file (the customer
 *    did NOT capture one inline — otherwise nothing to ask),
 *  - only for salons opted into the AI policy agent (ai_noshow_policy_*),
 *  - SMS through the same guard + kill-switch chokepoint; email is the reliable
 *    parallel channel (A2P link filtering). Best-effort; never throws.
 */
export async function sendOnlineSaveCardLink(bookingId: string): Promise<void> {
  try {
    const db = createServiceRoleClient();
    const { data: bk } = await db
      .from("bookings" as never)
      .select(
        "id, salon_id, client_phone, client_email, client_name, client_locale, noshow_card_required, noshow_card_id",
      )
      .eq("id", bookingId)
      .maybeSingle();
    const b = bk as Record<string, unknown> | null;
    if (!b) return;

    // Only when a card is required AND none is saved yet (inline capture sets
    // noshow_card_id → nothing to chase).
    if (b.noshow_card_required !== true) return;
    if (b.noshow_card_id) return;

    const phone = String(b.client_phone ?? "").trim();
    const email = String(b.client_email ?? "").trim();
    if (!phone && !email) return;

    const salonId = String(b.salon_id ?? "");
    const { data: salonRow } = await db
      .from("salons" as never)
      .select("name, address, email_links_enabled, noshow_protection_enabled, feature_flags")
      .eq("id", salonId)
      .maybeSingle();
    const salon = (salonRow ?? {}) as {
      name?: string | null;
      address?: string | null;
      email_links_enabled?: boolean;
      noshow_protection_enabled?: boolean;
      feature_flags?: Record<string, unknown> | null;
    };
    if (!salon.noshow_protection_enabled) return;

    // Auto-reach is part of letting the AI run the relationship layer — gate on
    // the agent opt-in so non-AI salons keep the inline-only behavior.
    const flags = salon.feature_flags;
    const aiOptedIn =
      flags?.ai_noshow_policy_live === true || flags?.ai_noshow_policy_shadow === true;
    if (!aiOptedIn) return;

    const token = await generateReminderToken(bookingId, salonId, {
      action: "card_manage",
      expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    });
    if (!token) return;
    const url = `${SITE_URL}/booking/save-card?token=${token.id}`;

    const salonName = (salon.name ?? "").trim() || "NailIQ";
    const lang: "en" | "vi" = String(b.client_locale ?? "").toLowerCase().startsWith("vi")
      ? "vi"
      : "en";
    const en = lang === "en";

    // Fixed templates (fail-safe), then AI personalisation on top.
    let smsBody = en
      ? `${salonName}: Save a card to hold your appointment — you're only charged if you no-show: ${url}`
      : `${salonName}: Lưu thẻ để giữ lịch hẹn — chỉ bị tính phí nếu bạn không đến: ${url}`;
    let emailBody = en
      ? "Save a card to hold your appointment — there's no upfront charge. You're only charged the no-show fee if you don't show up."
      : "Lưu thẻ để giữ lịch hẹn — không thu phí trước. Bạn chỉ bị tính phí vắng mặt nếu không đến.";

    try {
      const { draftSaveCardMessages, guardSmsLine } = await import(
        "@/shared/noshow/agentNoShowPolicy"
      );
      const drafted = await draftSaveCardMessages({
        salonId,
        lang,
        salonName,
        clientName: String(b.client_name ?? "") || null,
      });
      if (drafted) {
        const guardedSms = drafted.sms ? guardSmsLine(drafted.sms, salonName, url) : null;
        if (guardedSms) smsBody = guardedSms;
        if (drafted.email && drafted.email.length <= 600) emailBody = drafted.email;
      }
    } catch {
      /* keep fixed templates */
    }

    if (phone) {
      try {
        await sendSmsReminder(phone, smsBody, {
          salonId,
          lang,
          bookingId,
          notificationType: "save_card_link",
        });
      } catch (e) {
        console.error("[sendOnlineSaveCardLink] sms", e);
      }
    }
    if (email && salon.email_links_enabled !== false) {
      try {
        await sendCustomerLinkEmail({
          email,
          clientName: String(b.client_name ?? "") || null,
          salonName,
          salonAddress: salon.address ?? null,
          lang,
          subject: en
            ? `Save a card to hold your appointment · ${salonName}`
            : `Lưu thẻ để giữ lịch hẹn · ${salonName}`,
          bodyText: emailBody,
          ctaLabel: en ? "Save a card" : "Lưu thẻ",
          url,
        });
      } catch (e) {
        console.error("[sendOnlineSaveCardLink] email", e);
      }
    }
  } catch (e) {
    console.error("[sendOnlineSaveCardLink]", e);
  }
}
