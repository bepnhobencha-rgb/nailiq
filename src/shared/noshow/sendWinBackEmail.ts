import { getResendClient, getResendFrom } from "@/shared/lib/resend";

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

  const rebookUrl = `${SITE_URL}/${input.salonSlug}`;
  const name = input.clientName.trim() || "there";
  const salon = input.salonName.trim() || "us";

  const html = buildHtml({
    name,
    salon,
    serviceName: input.serviceName.trim(),
    rebookUrl,
  });

  try {
    const { error } = await resend.emails.send({
      from: getResendFrom(),
      to: email,
      subject: `We missed you at ${salon} — rebook anytime`,
      html,
    });
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}

function buildHtml(p: {
  name: string;
  salon: string;
  serviceName: string;
  rebookUrl: string;
}): string {
  const svcLine = p.serviceName
    ? `We had your ${escapeHtml(p.serviceName)} on the books and missed seeing you.`
    : `We missed seeing you at your recent appointment.`;
  return `
  <div style="max-width:480px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <h2 style="font-size:18px;margin:0 0 12px;">Hi ${escapeHtml(p.name)}, we missed you 💛</h2>
    <p style="font-size:14px;line-height:1.6;margin:0 0 16px;color:#444;">
      ${svcLine} Life happens — whenever you're ready, your spot at
      <strong>${escapeHtml(p.salon)}</strong> is one tap away.
    </p>
    <a href="${p.rebookUrl}"
       style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;">
      Rebook now
    </a>
    <p style="font-size:12px;color:#999;margin:20px 0 0;">${escapeHtml(p.salon)}</p>
  </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
