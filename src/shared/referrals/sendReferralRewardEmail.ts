import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { isEmailSuppressed } from "@/shared/lib/emailCompliance";
import { buildEmailExperience } from "@/shared/lib/emailExperience";

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
        ? `Dùng mã này để được giảm ${percent}% cho lần đặt kế tiếp. Mã có hiệu lực 30 ngày.`
        : `Use this code for ${percent}% off your next booking. Valid for 30 days.`;
    const experience = buildEmailExperience({
      key: "referral_reward",
      locale: lang,
      subject,
      preheader: line,
      salonName,
      recipientEmail: to,
      badge: lang === "vi" ? "PHẦN THƯỞNG GIỚI THIỆU" : "REFERRAL REWARD",
      heading: lang === "vi" ? `Bạn nhận ${percent}% giảm giá` : `You earned ${percent}% off`,
      paragraphs: [intro, line],
      code,
      callout: {
        title: lang === "vi" ? "Phần thưởng đã được xác nhận" : "Reward confirmed",
        body: lang === "vi"
          ? "Mã và mức giảm trong email này lấy từ reward record đã hoàn tất; NailIQ không tự suy đoán ưu đãi."
          : "The code and discount in this email come from the completed reward record; NailIQ does not invent offers.",
      },
    });

    const res = await resend!.emails.send({
      from: getResendFrom(),
      to,
      subject,
      html: experience.html,
      text: experience.text,
      headers: experience.headers,
      tags: experience.tags,
    });
    if (res.error) console.error("[sendReferralRewardEmail]", role, res.error);
  }

  await Promise.allSettled([
    send(rrb?.client_email, langOf(rrb?.client_locale), input.referrerCode, input.referrerPercent, "referrer"),
    send(rb?.client_email, langOf(rb?.client_locale), input.refereeCode, input.refereePercent, "referee"),
  ]);
}
