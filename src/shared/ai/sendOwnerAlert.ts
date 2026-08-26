"use server";
import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { parseOwnerNotificationSettings } from "@/shared/dashboard/ownerNotificationSettings";

/**
 * Unified owner alert — delivers via email, SMS, or both depending on
 * `salons.owner_notification_channel`. Used by Báo Cáo Viên, Radar, and
 * any future ACT+UNDO notification. Never throws; always best-effort.
 *
 * Email recipients: same resolution as sendOwnerBookingNotification
 * (owner/admin members + customEmails from owner_notification_settings).
 *
 * SMS recipient: salons.owner_phone (E.164). Only sent when channel is
 * 'sms' or 'both' and the phone is configured.
 */

type AlertInput = {
  subject: string;
  /** Plain-text fallback (also used as the SMS body). */
  bodyText: string;
  /** Rich HTML for email clients. Falls back to wrapping bodyText in <pre>. */
  bodyHtml?: string;
};

type SalonRow = {
  name: string | null;
  owner_notification_settings: unknown;
  owner_notification_channel: string | null;
  owner_phone: string | null;
};

async function resolveEmailRecipients(
  admin: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  notifyMembers: boolean,
  customEmails: string[],
): Promise<string[]> {
  const set = new Set<string>();
  for (const e of customEmails) set.add(e.toLowerCase());
  if (notifyMembers) {
    const { data: members } = await admin
      .from("salon_members")
      .select("user_id, role")
      .eq("salon_id", salonId)
      .in("role", ["owner", "admin"]);
    const userIds = Array.from(
      new Set(
        ((members ?? []) as { user_id: string }[])
          .map((m) => m.user_id)
          .filter(Boolean),
      ),
    );
    const emails = await Promise.all(
      userIds.map(async (uid) => {
        const { data, error } = await admin.auth.admin.getUserById(uid);
        return error ? null : (data.user?.email ?? null);
      }),
    );
    for (const e of emails) if (e) set.add(e.toLowerCase());
  }
  return Array.from(set);
}

export async function sendOwnerAlert(
  salonId: string,
  input: AlertInput,
): Promise<void> {
  try {
    const admin = createServiceRoleClient();

    const { data: salonRow } = await admin
      .from("salons")
      .select(
        "name, owner_notification_settings, owner_notification_channel, owner_phone, feature_flags" as never,
      )
      .eq("id", salonId)
      .maybeSingle();

    // When unified digest is on, individual agent alerts are suppressed —
    // the digest consolidates everything into one end-of-day email.
    const flags = ((salonRow as { feature_flags?: Record<string, unknown> } | null)?.feature_flags) ?? {};
    if (flags.ai_unified_digest === true) return;
    const salon = salonRow as SalonRow | null;
    if (!salon) return;

    const channel = salon.owner_notification_channel ?? "email";
    const settings = parseOwnerNotificationSettings(salon.owner_notification_settings);
    const { subject, bodyText } = input;
    const bodyHtml =
      input.bodyHtml ??
      `<pre style="font-family:-apple-system,Segoe UI,sans-serif;white-space:pre-wrap;color:#1a1a1a">${bodyText.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))}</pre>`;

    // ── Email ────────────────────────────────────────────────────────────────
    if (channel === "email" || channel === "both") {
      try {
        const resend = getResendClient();
        if (resend && settings.enabled) {
          const recipients = await resolveEmailRecipients(
            admin,
            salonId,
            settings.notifyMembers,
            settings.customEmails,
          );
          if (recipients.length > 0) {
            const res = await resend.emails.send({
              from: getResendFrom(),
              to: recipients,
              subject,
              html: bodyHtml,
              text: bodyText,
            });
            if (res.error) {
              console.error("[sendOwnerAlert] resend", res.error);
            }
          }
        }
      } catch (e) {
        console.error("[sendOwnerAlert] email", e);
      }
    }

    // ── SMS ──────────────────────────────────────────────────────────────────
    if ((channel === "sms" || channel === "both") && salon.owner_phone?.trim()) {
      try {
        // SMS body: keep under 160 chars if possible; no opt-out line needed
        // for owner-directed operational messages, but sendSmsReminder appends it.
        const smsBody = bodyText.slice(0, 1400); // Twilio max 1600 chars
        await sendSmsReminder(salon.owner_phone.trim(), smsBody, { salonId });
      } catch (e) {
        console.error("[sendOwnerAlert] sms", e);
      }
    }
  } catch (e) {
    console.error("[sendOwnerAlert]", e);
  }
}
