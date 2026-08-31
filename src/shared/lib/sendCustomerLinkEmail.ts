import "server-only";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { isEmailSuppressed } from "@/shared/lib/emailCompliance";
import { buildEmailExperience } from "@/shared/lib/emailExperience";

/**
 * Send a single "here is your link" email to a customer — the EMAIL half of the
 * SMS-or-email parallel channel.
 *
 * Why this exists: US carriers silently filter link-bearing SMS sent from
 * numbers not registered for A2P 10DLC (Twilio reports them "sent" but the
 * handset never receives them). So every important link we text — save-card,
 * deposit, waitlist invite — should ALSO go out by email when we have an
 * address. This is the small, reusable email sender those desk actions call.
 *
 * These are TRANSACTIONAL by default (the customer is mid-booking), so we do
 * NOT gate on the marketing opt-out unless `respectOptOut` is set. We still send
 * the List-Unsubscribe headers + CASL footer for compliance.
 *
 * Returns `{ ok }` and never throws — a failed email must not break the desk
 * action's primary result. Returns `{ ok: false, error: "no_email" }` when no
 * address is available so callers can surface "added by email: no".
 */
export async function sendCustomerLinkEmail(input: {
  email: string | null | undefined;
  clientName?: string | null;
  salonName: string;
  salonAddress?: string | null;
  lang?: "en" | "vi";
  subject: string;
  /** Big heading line above the body (defaults to subject). */
  heading?: string;
  /** One or two sentences explaining the link. */
  bodyText: string;
  /** Button label, e.g. "Save a card" / "Lưu thẻ". */
  ctaLabel: string;
  url: string;
  /** Honour the marketing opt-out list (default false → transactional). */
  respectOptOut?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const email = (input.email ?? "").trim();
  if (!email) return { ok: false, error: "no_email" };

  const resend = getResendClient();
  if (!resend) return { ok: false, error: "resend_not_configured" };

  if (input.respectOptOut && (await isEmailSuppressed(email))) {
    // Opted out of optional mail — treat as a successful no-op.
    return { ok: true };
  }

  const lang = input.lang === "en" ? "en" : "vi";
  const greeting = input.clientName?.trim()
    ? lang === "en"
      ? `Hi ${input.clientName.trim()},`
      : `Chào ${input.clientName.trim()},`
    : "";
  const experience = buildEmailExperience({
    key: "customer_link",
    locale: lang,
    subject: input.subject,
    preheader: input.bodyText,
    salonName: input.salonName,
    salonAddress: input.salonAddress,
    recipientEmail: email,
    badge: lang === "vi" ? "LIÊN KẾT AN TOÀN" : "SECURE BOOKING LINK",
    greeting,
    heading: input.heading?.trim() || input.subject,
    paragraphs: [input.bodyText],
    callout: {
      title: "NailIQ Booking Check",
      body: lang === "vi"
        ? "Liên kết này được tạo cho yêu cầu hiện tại. Chỉ mở email sẽ không tự đổi lịch hoặc thu tiền."
        : "This link was created for your current request. Opening the email alone does not change your appointment or collect payment.",
    },
    actions: [{ label: input.ctaLabel, url: input.url }],
    note: lang === "vi"
      ? "Nếu nút không mở, hãy liên hệ trực tiếp với tiệm."
      : "If the button does not open, contact the salon directly.",
  });

  try {
    const { error } = await resend.emails.send({
      from: getResendFrom(),
      to: email,
      subject: input.subject,
      html: experience.html,
      text: experience.text,
      headers: experience.headers,
      tags: experience.tags,
    });
    if (error) {
      console.error("[sendCustomerLinkEmail] resend error", error);
      return { ok: false, error: String(error) };
    }
    return { ok: true };
  } catch (e) {
    console.error("[sendCustomerLinkEmail] threw", e);
    return { ok: false, error: String(e) };
  }
}
