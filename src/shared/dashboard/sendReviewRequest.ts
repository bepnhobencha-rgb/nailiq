import { randomBytes } from "node:crypto";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isEmailSuppressed } from "@/shared/lib/emailCompliance";
import { buildEmailExperience } from "@/shared/lib/emailExperience";
import {
  getEffectivePlanLimits,
  type PlanCheckSalon,
} from "@/shared/lib/subscriptionPlans";
import { isUsPhone } from "@/shared/lib/phoneRegion";

/**
 * Auto review request — Pro+ tier "Tự động xin đánh giá".
 *
 * Fired (fire-and-forget) from `updateBookingStatus` when a booking
 * flips to `completed`. Idempotent on `booking_id` via the unique
 * constraint in `public.reviews`; called twice for the same booking
 * is a no-op.
 *
 * Silently no-ops when any of:
 *   - The salon's effective plan doesn't include `hasAutoReviewRequest`
 *   - The booking has no client_email (most walk-ins)
 *   - The Resend client is unconfigured in dev (no API key)
 *   - A review row already exists for this booking
 *
 * Returns nothing — the caller doesn't await this and doesn't surface
 * the result to the operator. Errors are logged to console + ErrorReporter.
 */
export async function sendReviewRequest(bookingId: string): Promise<void> {
  try {
    const supabase = createServiceRoleClient();

    // 1. Pull booking + salon plan + service / staff names for email body.
    const { data: row, error } = await supabase
      .from("bookings")
      .select(
        `
        id, salon_id, staff_id, service_id, client_email, client_phone, client_locale,
        start_time_utc,
        salons!inner ( id, name, slug, subscription_plan, plan_override, feature_flags, timezone, google_review_url, sms_reminders_enabled, sms_a2p_registered ),
        services!bookings_service_id_fkey ( name ),
        staff ( name )
      `,
      )
      .eq("id", bookingId)
      .maybeSingle();

    if (error || !row) {
      console.error("[sendReviewRequest] booking lookup", error);
      return;
    }

    type Salon = {
      id: string;
      name: string | null;
      slug: string;
      subscription_plan: string | null;
      plan_override: string | null;
      feature_flags: Record<string, unknown> | null;
      timezone: string | null;
      google_review_url?: string | null;
      sms_reminders_enabled?: boolean | null;
      sms_a2p_registered?: boolean | null;
    };
    const salonRaw = (row as unknown as { salons: Salon | Salon[] | null })
      .salons;
    const salon: Salon | null = Array.isArray(salonRaw)
      ? (salonRaw[0] ?? null)
      : (salonRaw ?? null);
    if (!salon?.id) return;

    const planCheck: PlanCheckSalon = {
      subscription_plan: salon.subscription_plan,
      plan_override: salon.plan_override,
      feature_flags: salon.feature_flags,
    };
    if (!getEffectivePlanLimits(planCheck).hasAutoReviewRequest) {
      return;
    }

    const email =
      typeof (row as { client_email?: string | null }).client_email ===
      "string"
        ? String((row as { client_email: string }).client_email).trim()
        : "";
    if (!email) return;

    const rawLocale =
      typeof (row as { client_locale?: string | null }).client_locale === "string"
        ? String((row as { client_locale: string }).client_locale)
        : "";
    const lang: "en" | "vi" = rawLocale.toLowerCase().startsWith("vi") ? "vi" : "en";

    // 2. Idempotency — bail if a review row exists for this booking.
    const { data: existing } = await supabase
      .from("reviews")
      .select("id")
      .eq("booking_id", bookingId)
      .maybeSingle();
    if (existing?.id) return;

    // 3. Resend client may be null in dev (no API key). Skip but still
    //    create the review row so the owner panel reflects the request.
    const resend = getResendClient();
    const token = randomBytes(24).toString("hex");
    const phone = (row as { client_phone?: string | null }).client_phone ?? null;
    const staffId = (row as { staff_id?: string | null }).staff_id ?? null;
    const serviceId =
      (row as { service_id?: string | null }).service_id ?? null;

    const { error: insErr } = await supabase.from("reviews").insert({
      salon_id: salon.id,
      booking_id: bookingId,
      staff_id: staffId,
      service_id: serviceId,
      client_phone: phone,
      client_email: email,
      request_token: token,
      request_sent_at: new Date().toISOString(),
    } as never);
    if (insErr) {
      // 23505 = unique_violation — another concurrent call won the
      // insert race; safe to ignore.
      const code = (insErr as { code?: string }).code;
      if (code !== "23505") {
        console.error("[sendReviewRequest] insert review", insErr);
      }
      return;
    }

    if (!resend) {
      console.warn(
        "[sendReviewRequest] Resend not configured — review row created without email send",
      );
      return;
    }

    type ServiceJoin = { name: string | null };
    const serviceJoin = (row as { services?: ServiceJoin | ServiceJoin[] | null })
      .services;
    const serviceName = Array.isArray(serviceJoin)
      ? (serviceJoin[0]?.name ?? "")
      : (serviceJoin?.name ?? "");
    type StaffJoin = { name: string | null };
    const staffJoin = (row as { staff?: StaffJoin | StaffJoin[] | null }).staff;
    const staffName = Array.isArray(staffJoin)
      ? (staffJoin[0]?.name ?? "")
      : (staffJoin?.name ?? "");

    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const reviewUrl = `${siteUrl.replace(/\/$/, "")}/reviews/${token}`;
    const salonName = (salon.name ?? "").trim() || salon.slug;
    const googleReviewUrl =
      typeof salon.google_review_url === "string" &&
      salon.google_review_url.trim().length > 0
        ? salon.google_review_url.trim()
        : undefined;

    try {
      if (await isEmailSuppressed(email)) {
        // Review request is marketing → respect unsubscribe (skip email channel).
      } else {
      const subject = lang === "vi"
        ? `Cảm ơn bạn — đánh giá dịch vụ tại ${salonName}`
        : `How was your visit at ${salonName}?`;
      const reviewEmail = buildReviewEmail({
        email,
        salonName,
        serviceName,
        staffName,
        reviewUrl,
        googleReviewUrl,
        lang,
      });
      const res = await resend.emails.send({
        from: getResendFrom(),
        to: email,
        subject,
        html: reviewEmail.html,
        text: reviewEmail.text,
        headers: reviewEmail.headers,
        tags: reviewEmail.tags,
      });
      // Audit the email send too (the owner's Notifications widget showed only
      // the SMS channel for review requests before this).
      const { logNotification } = await import("@/shared/lib/notificationLog");
      await logNotification({
        bookingId,
        salonId: salon.id,
        notificationType: "review_request",
        channel: "email",
        bodyPreview: `Review request email → ${email}`,
        ok: !res.error,
        errorMessage: res.error ? String(res.error) : undefined,
      });
      if (res.error) {
        console.error("[sendReviewRequest] resend send", res.error);
      }
      }
    } catch (e) {
      console.error("[sendReviewRequest] resend threw", e);
    }

    // SMS channel — send if salon has sms_reminders_enabled + booking has phone.
    // A2P 10DLC guardrail: skip SMS for US numbers when salon hasn't registered.
    const smsEnabled = salon.sms_reminders_enabled === true;
    const clientPhone =
      typeof (row as { client_phone?: string | null }).client_phone === "string"
        ? String((row as { client_phone: string }).client_phone).trim()
        : "";
    const smsA2pRegistered = salon.sms_a2p_registered === true; // fail-safe: only an explicit true (A2P approved) permits US link-SMS

    if (smsEnabled && clientPhone && !(isUsPhone(clientPhone) && !smsA2pRegistered)) {
      const toE164 = clientPhone.startsWith("+")
        ? clientPhone
        : `+${clientPhone}`;
      const smsBody = lang === "vi"
        ? `Cảm ơn bạn đã ghé ${salonName}! Đánh giá dịch vụ (30 giây): ${reviewUrl} · Reply STOP to opt out.`
        : `Thanks for visiting ${salonName}! Share your feedback (30 sec): ${reviewUrl} · Reply STOP to opt out.`;
      const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
      const { sendSmsReminder } = await import("@/shared/lib/twilioSms");
      const {
        claimNotificationOnce,
        completeReviewRequestSmsNotification,
      } = await import("@/shared/lib/notificationLog");
      const { classifyReminderProviderResult } = await import(
        "@/shared/reminders/reminderDeliveryClaims"
      );
      const smsClaim = await claimNotificationOnce({
        bookingId,
        salonId: salon.id,
        notificationType: "review_request",
        channel: "sms",
        clientPhone: toE164,
        bodyPreview: smsBody,
      });
      if (smsClaim === "skip" || smsClaim === "unguarded") {
        console.error(
          "[sendReviewRequest] durable SMS correlation unavailable; provider not called",
        );
        return;
      }
      const callbackUrl = new URL("/api/twilio/status", SITE_URL);
      callbackUrl.searchParams.set("notification_id", smsClaim);
      const smsResult = await sendSmsReminder(toE164, smsBody, {
        salonId: salon.id,
        statusCallbackUrl: callbackUrl.toString(),
      });
      if (!smsResult.ok) {
        console.error("[sendReviewRequest] SMS failed", smsResult.error);
      }
      const classified = classifyReminderProviderResult(smsResult, "sms");
      const completed = await completeReviewRequestSmsNotification({
        notificationId: smsClaim,
        status: classified.status,
        providerMessageId: classified.providerMessageId,
        errorCode: classified.errorCode,
      });
      if (!completed) {
        console.error("[sendReviewRequest] durable SMS completion unavailable");
      }
    }
  } catch (e) {
    console.error("[sendReviewRequest] unexpected", e);
  }
}

function buildReviewEmail(input: {
  email: string;
  salonName: string;
  serviceName: string;
  staffName: string;
  reviewUrl: string;
  googleReviewUrl?: string;
  lang?: "en" | "vi";
}) {
  const { salonName, serviceName, staffName, reviewUrl, googleReviewUrl } = input;
  const vi = input.lang === "vi";

  const headline = vi ? `Cảm ơn bạn đã ghé ${salonName}!` : `Thank you for visiting ${salonName}!`;
  const body = vi
    ? "Chúng tôi rất vui được phục vụ bạn. Nếu bạn có vài phút, vui lòng chia sẻ trải nghiệm."
    : "We loved having you! If you have a minute, we'd love to hear how it went.";
  const linkNote = vi
    ? "Link NailIQ chỉ dành cho bạn — vui lòng không chia sẻ. Hết hạn sau 30 ngày."
    : "This link is just for you — please don't share. Expires in 30 days.";

  return buildEmailExperience({
    key: "review_request",
    locale: vi ? "vi" : "en",
    subject: vi
      ? `Cảm ơn bạn — đánh giá dịch vụ tại ${salonName}`
      : `How was your visit at ${salonName}?`,
    preheader: body,
    salonName,
    recipientEmail: input.email,
    badge: vi ? "TRẢI NGHIỆM CỦA BẠN" : "YOUR EXPERIENCE",
    heading: headline,
    paragraphs: [body],
    details: [
      serviceName ? { label: vi ? "Dịch vụ" : "Service", value: serviceName } : null,
      staffName ? { label: vi ? "Thợ" : "Technician", value: staffName } : null,
    ].filter((detail): detail is { label: string; value: string } => detail !== null),
    callout: {
      title: vi ? "30 giây là đủ" : "30 seconds is enough",
      body: vi
        ? "Phản hồi giúp tiệm chăm sóc khách tốt hơn. NailIQ không tự viết hoặc sửa đánh giá của bạn."
        : "Your feedback helps the salon improve. NailIQ does not write or alter your review.",
    },
    actions: googleReviewUrl
      ? [
        { label: vi ? "Đánh giá trên Google" : "Review on Google", url: googleReviewUrl },
        { label: vi ? "Đánh giá trên NailIQ" : "Rate on NailIQ", url: reviewUrl, kind: "secondary" },
      ]
      : [{ label: vi ? "Đánh giá dịch vụ" : "Leave a review", url: reviewUrl }],
    note: linkNote,
  });
}
