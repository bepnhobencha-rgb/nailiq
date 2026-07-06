import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import {
  complianceFooterHtml,
  listUnsubscribeHeaders,
  isEmailSuppressed,
} from "@/shared/lib/emailCompliance";

type Lang = "en" | "vi";
type Role = "referrer" | "referee";

const langOf = (l: string | null | undefined): Lang =>
  String(l ?? "").toLowerCase().startsWith("vi") ? "vi" : "en";

/**
 * Email both sides of a completed referral their reward voucher code. Best-effort
 * and self-gating: no Resend key (dev) → no-op; a recipient with no email on file,
 * a null voucher, or an unsubscribed address is silently skipped. SMS is
 * intentionally out of scope here (US A2P gating) — email surfaces the reward.
 */
export async function sendReferralRewardEmail(input: {
  bookingId: string;
  salonId: string;
  referrerPhone: string;
  refereePhone: string | null;
  referrerCode: string | null;
  refereeCode: string | null;
  referrerPercent: number;
  refereePercent: number;
}): Promise<void> {
  const resend = getResendClient();
  if (!resend) return;

  const db = createServiceRoleClient();

  const { data: salonRow } = await db
    .from("salons")
    .select("name, slug")
    .eq("id", input.salonId)
    .maybeSingle();
  const salon = salonRow as { name: string | null; slug: string } | null;
  if (!salon) return;
  const salonName = (salon.name ?? "").trim() || salon.slug;

  // Referee email + locale from THEIR booking.
  const { data: refereeBooking } = await db
    .from("bookings")
    .select("client_email, client_locale")
    .eq("id", input.bookingId)
    .maybeSingle();
  const rb = refereeBooking as { client_email: string | null; client_locale: string | null } | null;

  // Referrer email + locale from their most recent email-bearing booking here.
  const { data: referrerBooking } = await db
    .from("bookings")
    .select("client_email, client_locale")
    .eq("salon_id", input.salonId)
    .eq("client_phone", input.referrerPhone)
    .not("client_email", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const rrb = referrerBooking as { client_email: string | null; client_locale: string | null } | null;

  async function send(
    email: string | null | undefined,
    lang: Lang,
    code: string | null,
    percent: number,
    role: Role,
  ): Promise<void> {
    const to = (email ?? "").trim();
    if (!to || !code) return;
    if (await isEmailSuppressed(to)) return;

    const subject =
      lang === "vi"
        ? `🎁 Bạn nhận ${percent}% giảm giá tại ${salonName}`
        : `🎁 You earned ${percent}% off at ${salonName}`;
    const intro =
      lang === "vi"
        ? role === "referrer"
          ? `Cảm ơn bạn đã giới thiệu bạn bè đến ${salonName}!`
          : `Cảm ơn bạn đã ghé ${salonName} qua lời giới thiệu của bạn bè!`
        : role === "referrer"
          ? `Thanks for referring a friend to ${salonName}!`
          : `Thanks for visiting ${salonName} on a friend's referral!`;
    const line =
      lang === "vi"
        ? `Dùng mã <strong>${code}</strong> để được <strong>giảm ${percent}%</strong> cho lần đặt kế tiếp. Mã có hiệu lực 30 ngày.`
        : `Use code <strong>${code}</strong> for <strong>${percent}% off</strong> your next booking. Valid for 30 days.`;

    const html =
      `<!doctype html><html><body style="margin:0;background:#faf8f2">` +
      `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:28px;color:#1a1a1a">` +
      `<h1 style="font-size:20px;margin:0 0 12px">🎁 ${lang === "vi" ? "Phần thưởng giới thiệu" : "Referral reward"}</h1>` +
      `<p style="font-size:14px;line-height:1.6;margin:0 0 14px">${intro}</p>` +
      `<p style="font-size:14px;line-height:1.6;margin:0 0 18px">${line}</p>` +
      `<div style="font-family:monospace;font-size:22px;font-weight:700;letter-spacing:2px;padding:14px;text-align:center;background:#f1ead9;border-radius:10px">${code}</div>` +
      `</div></body></html>`;
    const withFooter = html.replace(
      "</body>",
      `${complianceFooterHtml({ email: to, salonName, lang })}</body>`,
    );

    const res = await resend!.emails.send({
      from: getResendFrom(),
      to,
      subject,
      html: withFooter,
      headers: listUnsubscribeHeaders(to),
    });
    if (res.error) console.error("[sendReferralRewardEmail]", role, res.error);
  }

  await Promise.allSettled([
    send(rrb?.client_email, langOf(rrb?.client_locale), input.referrerCode, input.referrerPercent, "referrer"),
    send(rb?.client_email, langOf(rb?.client_locale), input.refereeCode, input.refereePercent, "referee"),
  ]);
}
