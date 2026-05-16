import { randomBytes } from "node:crypto";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  getEffectivePlanLimits,
  type PlanCheckSalon,
} from "@/shared/lib/subscriptionPlans";

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
 * the result to the operator. Errors are logged to console + Sentry.
 */
export async function sendReviewRequest(bookingId: string): Promise<void> {
  try {
    const supabase = createServiceRoleClient();

    // 1. Pull booking + salon plan + service / staff names for email body.
    const { data: row, error } = await supabase
      .from("bookings")
      .select(
        `
        id, salon_id, staff_id, service_id, client_email, client_phone,
        start_time_utc,
        salons!inner ( id, name, slug, subscription_plan, plan_override, feature_flags, timezone ),
        services ( name ),
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

    try {
      const res = await resend.emails.send({
        from: getResendFrom(),
        to: email,
        subject: `Cảm ơn bạn — đánh giá dịch vụ tại ${salonName}`,
        html: buildEmailHtml({
          salonName,
          serviceName,
          staffName,
          reviewUrl,
        }),
      });
      if (res.error) {
        console.error("[sendReviewRequest] resend send", res.error);
      }
    } catch (e) {
      console.error("[sendReviewRequest] resend threw", e);
    }
  } catch (e) {
    console.error("[sendReviewRequest] unexpected", e);
  }
}

function buildEmailHtml(input: {
  salonName: string;
  serviceName: string;
  staffName: string;
  reviewUrl: string;
}): string {
  const { salonName, serviceName, staffName, reviewUrl } = input;
  const serviceLine = serviceName
    ? `<p style="margin: 0 0 8px 0;">Dịch vụ: <strong>${escapeHtml(serviceName)}</strong></p>`
    : "";
  const staffLine = staffName
    ? `<p style="margin: 0 0 8px 0;">Thợ: <strong>${escapeHtml(staffName)}</strong></p>`
    : "";
  return `
    <!doctype html>
    <html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
      <h1 style="font-size: 20px; margin: 0 0 16px 0;">Cảm ơn bạn đã ghé ${escapeHtml(salonName)}!</h1>
      <p style="margin: 0 0 16px 0;">Chúng tôi rất vui được phục vụ bạn hôm nay. Nếu bạn có vài phút, vui lòng chia sẻ trải nghiệm.</p>
      ${serviceLine}
      ${staffLine}
      <p style="margin: 24px 0;">
        <a href="${reviewUrl}" style="display: inline-block; background: #d4af37; color: #111; padding: 12px 24px; border-radius: 999px; text-decoration: none; font-weight: 600;">Đánh giá dịch vụ</a>
      </p>
      <p style="font-size: 12px; color: #666; margin: 24px 0 0 0;">Link này chỉ dành cho bạn — vui lòng không chia sẻ. Hết hạn sau 30 ngày.</p>
    </body></html>
  `.trim();
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
