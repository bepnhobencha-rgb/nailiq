import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { isEmailSuppressed } from "@/shared/lib/emailCompliance";
import { buildEmailExperience } from "@/shared/lib/emailExperience";

const SITE_URL =
  (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";

export interface WinBackEmailInput {
  clientName: string;
  clientEmail: string;
  /** Salon display name (from DB — never hardcoded). */
  salonName: string;
  /** Salon slug → rebook deep link. */
  salonSlug: string;
  /** Service the guest missed, for a warm, specific line. */
  serviceName: string;
}

/**
 * Friendly win-back after a no-show: "we missed you — rebook in one tap".
 * Retention over penalty. Best-effort: returns ok=false instead of throwing so
 * the desk no-show action never fails on an email hiccup. All brand/copy comes
 * from the salon row (no hardcode) except the generic template wording.
 */
export async function sendWinBackEmail(
  input: WinBackEmailInput,
): Promise<{ ok: boolean }> {
  const resend = getResendClient();
  if (!resend) return { ok: false };

  const email = input.clientEmail.trim();
  if (!email) return { ok: false };

  // Win-back is marketing → honour unsubscribe.
  if (await isEmailSuppressed(email)) return { ok: true };

  const rebookUrl = `${SITE_URL}/${input.salonSlug}`;
  const name = input.clientName.trim() || "there";
  const salon = input.salonName.trim() || "us";

  const serviceName = input.serviceName.trim();
  const experience = buildEmailExperience({
    key: "winback",
    locale: "en",
    subject: `We missed you at ${salon} — rebook anytime`,
    preheader: `Your next visit at ${salon} is one tap away.`,
    salonName: salon,
    recipientEmail: email,
    badge: "WELCOME BACK",
    greeting: `Hi ${name},`,
    heading: "We missed you 💛",
    paragraphs: [
      serviceName
        ? `We had your ${serviceName} on the books and missed seeing you.`
        : "We missed seeing you at your recent appointment.",
      "Life happens. Whenever you're ready, you can choose a new time in one tap.",
    ],
    callout: {
      title: "No pressure",
      body: "This email does not create a booking or charge a fee. You stay in control until you confirm a new appointment.",
    },
    actions: [{ label: "Rebook now", url: rebookUrl }],
  });

  try {
    const { error } = await resend.emails.send({
      from: getResendFrom(),
      to: email,
      subject: `We missed you at ${salon} — rebook anytime`,
      html: experience.html,
      text: experience.text,
      headers: experience.headers,
      tags: experience.tags,
    });
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}
