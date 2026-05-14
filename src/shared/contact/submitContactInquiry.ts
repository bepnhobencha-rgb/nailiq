"use server";

import { headers } from "next/headers";
import * as Sentry from "@sentry/nextjs";
import { isRateLimited, RATE_LIMIT_IDS } from "@/shared/lib/rateLimit";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";

const NAME_MAX = 100;
const SALON_MAX = 200;
const MESSAGE_MAX = 4000;
const EMAIL_MAX = 254;

const CONTACT_INBOX = "hello@nailiq.ca";

export type ContactInquiryResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid_name"
        | "invalid_email"
        | "invalid_message"
        | "rate_limited"
        | "server_error";
    };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Public marketing contact form submission. Validates input, applies
 * a Vercel WAF rate-limit check (fail-open until the rule is
 * configured), and forwards via Resend to the team inbox.
 *
 * Honeypot: bots that fill the hidden `_botField` get a silent
 * success — keeps the form usable while dropping spam.
 *
 * Reply-To is set to the submitter's email so the team can hit
 * "reply" in their email client directly.
 */
export async function submitContactInquiry(input: {
  name: string;
  email: string;
  salon?: string;
  message: string;
  /** Hidden honeypot field. Real users leave it empty; bots fill it. */
  _botField?: string;
}): Promise<ContactInquiryResult> {
  if (input._botField && input._botField.trim().length > 0) {
    // Silent drop — pretend success so the bot moves on without
    // retrying or escalating.
    return { ok: true };
  }

  const name = (input.name ?? "").trim();
  if (name.length === 0 || name.length > NAME_MAX) {
    return { ok: false, reason: "invalid_name" };
  }

  const email = (input.email ?? "").trim();
  if (
    email.length === 0 ||
    email.length > EMAIL_MAX ||
    !isValidEmailFormat(email)
  ) {
    return { ok: false, reason: "invalid_email" };
  }

  const message = (input.message ?? "").trim();
  if (message.length === 0 || message.length > MESSAGE_MAX) {
    return { ok: false, reason: "invalid_message" };
  }

  const salon = (input.salon ?? "").trim().slice(0, SALON_MAX);

  try {
    const hdrs = await headers();
    const blocked = await isRateLimited(RATE_LIMIT_IDS.contactSubmit, {
      headers: hdrs as unknown as Headers,
    });
    if (blocked) return { ok: false, reason: "rate_limited" };
  } catch {
    // Rate-limit subsystem unavailable — fail-open. The honeypot +
    // Resend's own rate caps are the secondary defenses.
  }

  const resend = getResendClient();
  if (!resend) {
    // Dev-only path; production throws inside `getResendClient`.
    console.log("[contact] would send inquiry:", {
      name,
      email,
      salon,
      messagePreview: message.slice(0, 80),
    });
    return { ok: true };
  }

  const subject = salon
    ? `Contact form: ${name} (${salon})`
    : `Contact form: ${name}`;
  const text = [
    `Name:  ${name}`,
    `Email: ${email}`,
    `Salon: ${salon || "—"}`,
    "",
    "Message:",
    message,
  ].join("\n");
  const html = `<!doctype html>
<html><body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #111; line-height: 1.6;">
  <h2 style="margin: 0 0 16px;">New contact-form inquiry</h2>
  <table style="border-collapse: collapse; margin: 0 0 20px;">
    <tr><td style="padding: 4px 12px 4px 0; color: #666; font-weight: 600;">Name</td><td style="padding: 4px 0;">${escapeHtml(name)}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #666; font-weight: 600;">Email</td><td style="padding: 4px 0;"><a href="mailto:${escapeHtml(email)}" style="color: #D4AF37;">${escapeHtml(email)}</a></td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #666; font-weight: 600;">Salon</td><td style="padding: 4px 0;">${escapeHtml(salon || "—")}</td></tr>
  </table>
  <p style="margin: 0 0 8px; color: #666; font-weight: 600;">Message:</p>
  <div style="white-space: pre-wrap; padding: 16px; background: #f7f5ef; border-left: 3px solid #D4AF37; border-radius: 4px;">${escapeHtml(message)}</div>
  <p style="margin: 24px 0 0; color: #999; font-size: 12px;">
    Reply directly to this email to reach ${escapeHtml(name)}.
  </p>
</body></html>`;

  try {
    const res = await resend.emails.send({
      from: getResendFrom(),
      to: CONTACT_INBOX,
      replyTo: email,
      subject,
      text,
      html,
    });
    if (res.error) {
      Sentry.captureMessage("[contact] Resend send error", {
        level: "error",
        extra: { message: res.error.message },
      });
      return { ok: false, reason: "server_error" };
    }
  } catch (e) {
    Sentry.captureException(e, {
      tags: { surface: "contact" },
    });
    return { ok: false, reason: "server_error" };
  }

  return { ok: true };
}
