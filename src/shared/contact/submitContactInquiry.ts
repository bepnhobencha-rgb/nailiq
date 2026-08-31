"use server";

import { headers } from "next/headers";
import * as ErrorReporter from "@/shared/observability/errorReporter";
import { isRateLimited, RATE_LIMIT_IDS } from "@/shared/lib/rateLimit";
import {
  clientIpFromHeaders,
  durableRateLimitKey,
  isOverRateLimit,
} from "@/shared/lib/inAppRateLimit";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { emailExperienceTags } from "@/shared/lib/emailExperienceRegistry";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";

const NAME_MAX = 100;
const SALON_MAX = 200;
const MESSAGE_MAX = 4000;
const EMAIL_MAX = 254;
const POS_OTHER_MAX = 80;

const CONTACT_INBOX = "thehuytgvn@gmail.com";

/**
 * Founder Pilot form fields (all optional). Additive on the existing
 * contact pipeline: they are serialized into the outbound email
 * subject/body so we do not need a DB migration for the pilot launch.
 */
export type ContactPos = "square" | "clover" | "toast" | "other" | "none";
export type ContactPlan = "monthly" | "annual" | "unsure";
export type ContactIntent = "pilot" | "demo";

function isPos(v: unknown): v is ContactPos {
  return (
    v === "square" ||
    v === "clover" ||
    v === "toast" ||
    v === "other" ||
    v === "none"
  );
}
function isPlan(v: unknown): v is ContactPlan {
  return v === "monthly" || v === "annual" || v === "unsure";
}
function isIntent(v: unknown): v is ContactIntent {
  return v === "pilot" || v === "demo";
}

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
 * both a Vercel WAF signal and a durable fail-closed DB rate limit, then
 * forwards via Resend to the team inbox.
 *
 * Honeypot: bots that fill the hidden `_botField` get a silent
 * success — keeps the form usable while dropping spam.
 *
 * Reply-To is set to the submitter's email so the team can hit
 * "reply" in their email client directly.
 *
 * Founder Pilot fields (`pos`, `posOther`, `plan`, `intent`) are
 * optional. When present they are inlined into the email subject
 * and body — no schema change required.
 */
export async function submitContactInquiry(input: {
  name: string;
  email: string;
  salon?: string;
  message: string;
  /** Founder Pilot: current POS system. */
  pos?: string;
  /** Founder Pilot: free-text POS name when `pos === "other"`. */
  posOther?: string;
  /** Founder Pilot: preferred pricing option. */
  plan?: string;
  /** Founder Pilot: `pilot` or `demo` — set by the CTA that opened the form. */
  intent?: string;
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

  const posRaw = typeof input.pos === "string" ? input.pos.trim() : "";
  const pos: ContactPos | null = isPos(posRaw) ? posRaw : null;
  const posOther =
    pos === "other"
      ? (input.posOther ?? "").trim().slice(0, POS_OTHER_MAX)
      : "";
  const planRaw = typeof input.plan === "string" ? input.plan.trim() : "";
  const plan: ContactPlan | null = isPlan(planRaw) ? planRaw : null;
  const intentRaw = typeof input.intent === "string" ? input.intent.trim() : "";
  const intent: ContactIntent | null = isIntent(intentRaw) ? intentRaw : null;

  try {
    const hdrs = await headers();
    const rateHeaders = hdrs as unknown as Headers;
    const ip = clientIpFromHeaders(rateHeaders);
    const blocked =
      (await isRateLimited(RATE_LIMIT_IDS.contactSubmit, {
        headers: rateHeaders,
      })) ||
      (await isOverRateLimit(
        durableRateLimitKey("contact-submit", ip),
        5,
        60 * 60,
        {
          failureMode: "block",
        },
      ));
    if (blocked) return { ok: false, reason: "rate_limited" };
  } catch {
    // Header/runtime failure is not a reason to open a public provider path.
    return { ok: false, reason: "rate_limited" };
  }

  let resend: Awaited<ReturnType<typeof getResendClient>>;
  try {
    resend = getResendClient();
  } catch (e) {
    ErrorReporter.captureException(e, { tags: { surface: "contact" } });
    return { ok: false, reason: "server_error" };
  }

  if (!resend) {
    // Dev-only path; production throws inside `getResendClient`.
    console.log("[contact] would send inquiry:", {
      name,
      email,
      salon,
      pos,
      posOther,
      plan,
      intent,
      messagePreview: message.slice(0, 80),
    });
    return { ok: true };
  }

  const posLabel =
    pos === "other" && posOther
      ? `Other — ${posOther}`
      : pos
        ? pos.charAt(0).toUpperCase() + pos.slice(1)
        : "—";
  const planLabel = plan
    ? plan === "unsure"
      ? "Not sure"
      : plan === "monthly"
        ? "Monthly Pilot"
        : "Annual Pilot"
    : "—";
  const intentPrefix =
    intent === "pilot"
      ? "[Founder Pilot] "
      : intent === "demo"
        ? "[Demo request] "
        : "";

  const subject = salon
    ? `${intentPrefix}Contact form: ${name} (${salon})`
    : `${intentPrefix}Contact form: ${name}`;
  const text = [
    `Name:   ${name}`,
    `Email:  ${email}`,
    `Salon:  ${salon || "—"}`,
    `POS:    ${posLabel}`,
    `Plan:   ${planLabel}`,
    `Intent: ${intent ?? "—"}`,
    "",
    "Message:",
    message,
  ].join("\n");
  const html = `<!doctype html>
<html><body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #111; line-height: 1.6;">
  <h2 style="margin: 0 0 16px;">${intentPrefix ? escapeHtml(intentPrefix.trim()) + " " : ""}New contact-form inquiry</h2>
  <table style="border-collapse: collapse; margin: 0 0 20px;">
    <tr><td style="padding: 4px 12px 4px 0; color: #666; font-weight: 600;">Name</td><td style="padding: 4px 0;">${escapeHtml(name)}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #666; font-weight: 600;">Email</td><td style="padding: 4px 0;"><a href="mailto:${escapeHtml(email)}" style="color: #D4AF37;">${escapeHtml(email)}</a></td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #666; font-weight: 600;">Salon</td><td style="padding: 4px 0;">${escapeHtml(salon || "—")}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #666; font-weight: 600;">POS</td><td style="padding: 4px 0;">${escapeHtml(posLabel)}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #666; font-weight: 600;">Plan</td><td style="padding: 4px 0;">${escapeHtml(planLabel)}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #666; font-weight: 600;">Intent</td><td style="padding: 4px 0;">${escapeHtml(intent ?? "—")}</td></tr>
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
      tags: emailExperienceTags("contact_inquiry"),
    });
    if (res.error) {
      ErrorReporter.captureMessage("[contact] Resend send error", {
        level: "error",
        extra: { message: res.error.message },
      });
      return { ok: false, reason: "server_error" };
    }
  } catch (e) {
    ErrorReporter.captureException(e, {
      tags: { surface: "contact" },
    });
    return { ok: false, reason: "server_error" };
  }

  return { ok: true };
}
