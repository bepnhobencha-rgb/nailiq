import "server-only";

import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { emailExperienceTags } from "@/shared/lib/emailExperienceRegistry";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type { UserLanguage } from "@/shared/i18n/user/types";
import type { ReleaseReviewContext } from "@/shared/superadmin/releaseReviewContext";
import { ownerFriendlyReleaseSummary } from "@/shared/superadmin/releaseReviewPresentation";

const RELEASE_REVIEW_RECIPIENT = "thehuytgvn@gmail.com";
const CLAIM_LEASE_MS = 10 * 60 * 1_000;
const MAX_EMAIL_ATTEMPTS = 3;

type ReviewRow = {
  id: string;
  deployment_id: string;
  change_summary: string;
  status: string;
  recipient_email: string;
  email_attempt_count: number;
  email_claimed_at: string | null;
  email_sent_at: string | null;
};

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function appUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return (configured || "https://www.nailiq.ca").replace(/\/$/, "");
}

export function releaseReviewDecisionUrl(
  reviewId: string,
  intent: "approved" | "declined",
): string {
  return `${appUrl()}/superadmin/operations/release-reviews/${encodeURIComponent(reviewId)}?intent=${intent}`;
}

export function buildReleaseReviewEmail(input: {
  reviewId: string;
  deploymentId: string;
  changeSummary: string;
  language?: UserLanguage;
}): { subject: string; html: string; text: string } {
  const approveUrl = releaseReviewDecisionUrl(input.reviewId, "approved");
  const declineUrl = releaseReviewDecisionUrl(input.reviewId, "declined");
  const language = input.language === "vi" ? "vi" : "en";
  const isVietnamese = language === "vi";
  const friendlySummary = ownerFriendlyReleaseSummary(
    input.changeSummary,
    language,
  );
  const copy = isVietnamese
    ? {
        subject: "NailIQ: Có cần soạn thông báo cho chủ salon không?",
        eyebrow: "NailIQ · Duyệt thông báo cho salon",
        heading: "Bạn có muốn NailIQ soạn thông báo cho chủ salon?",
        intro:
          "Một bản cập nhật NailIQ vừa được kích hoạt. Chưa có thông báo nào được gửi đến salon hoặc khách hàng.",
        summaryLabel: "Thay đổi gì?",
        statusLabel: "Trạng thái thông báo",
        statusValue: "Chưa gửi",
        actionLabel: "Bạn cần làm gì?",
        actionValue: "Chọn có soạn bản nháp để duyệt hay không.",
        approve: "Soạn bản nháp Anh & Việt để tôi duyệt",
        decline: "Không thông báo cho salon",
        safety:
          "Bấm “Soạn bản nháp” chỉ mở nội dung để bạn đọc và chỉnh sửa. NailIQ sẽ không gửi nếu chưa có phê duyệt cuối cùng của bạn.",
      }
    : {
        subject: "NailIQ: Should we prepare a salon-owner announcement?",
        eyebrow: "NailIQ · Salon communication review",
        heading: "Would you like NailIQ to prepare a salon-owner announcement?",
        intro:
          "A NailIQ update is now active. No announcement has been sent to salons or customers.",
        summaryLabel: "What changed?",
        statusLabel: "Notification status",
        statusValue: "Not sent",
        actionLabel: "What do you need to do?",
        actionValue: "Choose whether NailIQ should prepare drafts for review.",
        approve: "Prepare English & Vietnamese drafts",
        decline: "Do not notify salons",
        safety:
          "Preparing drafts only opens content for your review and editing. NailIQ will not send anything without your final approval.",
      };
  const subject = copy.subject;
  const html = `<div style="max-width:560px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#171717">
  <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#737373">${esc(copy.eyebrow)}</p>
  <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25">${esc(copy.heading)}</h1>
  <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404040">${esc(copy.intro)}</p>
  <div style="margin:0 0 22px;padding:16px;border:1px solid #e5e5e5;border-radius:12px;background:#fafafa">
    <p style="margin:0 0 6px;font-size:12px;color:#737373">${esc(copy.summaryLabel)}</p>
    <p style="margin:0;font-size:15px;line-height:1.55">${esc(friendlySummary)}</p>
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid #e5e5e5">
      <p style="margin:0 0 4px;font-size:12px;color:#737373">${esc(copy.statusLabel)}</p>
      <p style="margin:0 0 12px;font-size:14px;font-weight:700">${esc(copy.statusValue)}</p>
      <p style="margin:0 0 4px;font-size:12px;color:#737373">${esc(copy.actionLabel)}</p>
      <p style="margin:0;font-size:14px;line-height:1.5">${esc(copy.actionValue)}</p>
    </div>
  </div>
  <div style="margin:0 0 20px">
    <a href="${esc(approveUrl)}" style="display:inline-block;margin:0 8px 8px 0;padding:12px 20px;border-radius:999px;background:#171717;color:#fff;text-decoration:none;font-size:14px;font-weight:700">${esc(copy.approve)}</a>
    <a href="${esc(declineUrl)}" style="display:inline-block;margin:0 0 8px;padding:12px 20px;border:1px solid #d4d4d4;border-radius:999px;background:#fff;color:#171717;text-decoration:none;font-size:14px;font-weight:700">${esc(copy.decline)}</a>
  </div>
  <p style="margin:0;font-size:12px;line-height:1.55;color:#737373">${esc(copy.safety)}</p>
</div>`;
  const text = `${copy.heading}\n\n${copy.intro}\n\n${copy.summaryLabel}\n${friendlySummary}\n\n${copy.statusLabel}: ${copy.statusValue}\n${copy.actionLabel}: ${copy.actionValue}\n\n${copy.approve}: ${approveUrl}\n${copy.decline}: ${declineUrl}\n\n${copy.safety}`;
  return { subject, html, text };
}

async function releaseReviewRecipientLanguage(
  email: string,
): Promise<UserLanguage> {
  try {
    const admin = createServiceRoleClient();
    const { data, error } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (error) {
      console.error("[release-review] recipient language", error);
      return "en";
    }
    const user = data.users.find(
      (candidate) => candidate.email?.toLowerCase() === email.toLowerCase(),
    );
    return user?.user_metadata?.user_language === "vi" ? "vi" : "en";
  } catch (error) {
    console.error("[release-review] recipient language", error);
    return "en";
  }
}

async function findOrCreateReview(
  context: ReleaseReviewContext,
): Promise<ReviewRow | null> {
  const db = createServiceRoleClient();
  const inserted = (await db
    .from("platform_release_reviews" as never)
    .insert(
      {
        deployment_id: context.deploymentId,
        change_summary: context.changeSummary,
        recipient_email: RELEASE_REVIEW_RECIPIENT,
      } as never,
    )
    .select(
      "id, deployment_id, change_summary, status, recipient_email, email_attempt_count, email_claimed_at, email_sent_at" as never,
    )
    .maybeSingle()) as { data: ReviewRow | null; error: { code?: string } | null };

  if (inserted.data) return inserted.data;
  if (inserted.error?.code !== "23505") {
    console.error("[release-review] insert", inserted.error);
    return null;
  }

  const existing = (await db
    .from("platform_release_reviews" as never)
    .select(
      "id, deployment_id, change_summary, status, recipient_email, email_attempt_count, email_claimed_at, email_sent_at" as never,
    )
    .eq("deployment_id" as never, context.deploymentId)
    .maybeSingle()) as { data: ReviewRow | null; error: unknown };
  if (existing.error) {
    console.error("[release-review] load existing", existing.error);
    return null;
  }
  return existing.data;
}

export type EnsureReleaseReviewEmailResult = {
  ok: boolean;
  state:
    | "sent"
    | "already_sent"
    | "already_decided"
    | "retry_later"
    | "exhausted"
    | "send_failed"
    | "server_error";
};

export async function ensureReleaseReviewEmail(
  context: ReleaseReviewContext,
  now = new Date(),
): Promise<EnsureReleaseReviewEmailResult> {
  let row: ReviewRow | null;
  try {
    row = await findOrCreateReview(context);
  } catch (error) {
    console.error("[release-review] prepare", error);
    return { ok: false, state: "server_error" };
  }
  if (!row) return { ok: false, state: "server_error" };
  if (row.status !== "pending") return { ok: true, state: "already_decided" };
  if (row.email_sent_at) return { ok: true, state: "already_sent" };
  if (row.email_attempt_count >= MAX_EMAIL_ATTEMPTS) {
    return { ok: false, state: "exhausted" };
  }

  const claimExpiredBefore = new Date(now.getTime() - CLAIM_LEASE_MS).toISOString();
  const db = createServiceRoleClient();
  const claim = (await db
    .from("platform_release_reviews" as never)
    .update(
      {
        email_claimed_at: now.toISOString(),
        email_attempt_count: row.email_attempt_count + 1,
        email_last_error: null,
      } as never,
    )
    .eq("id" as never, row.id)
    .eq("status" as never, "pending")
    .eq("email_attempt_count" as never, row.email_attempt_count)
    .is("email_sent_at" as never, null)
    .or(
      `email_claimed_at.is.null,email_claimed_at.lt.${claimExpiredBefore}` as never,
    )
    .select("id" as never)
    .maybeSingle()) as { data: { id: string } | null; error: unknown };

  if (claim.error) {
    console.error("[release-review] claim", claim.error);
    return { ok: false, state: "server_error" };
  }
  if (!claim.data) return { ok: true, state: "retry_later" };

  try {
    const resend = getResendClient();
    if (!resend) throw new Error("resend_not_configured");
    const email = buildReleaseReviewEmail({
      reviewId: row.id,
      deploymentId: row.deployment_id,
      changeSummary: row.change_summary,
      language: await releaseReviewRecipientLanguage(row.recipient_email),
    });
    const { data, error } = await resend.emails.send(
      {
        from: getResendFrom(),
        to: row.recipient_email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        tags: emailExperienceTags("release_review"),
      },
      { idempotencyKey: `nailiq-release-review-${row.deployment_id}` },
    );
    if (error) throw new Error("resend_send_failed", { cause: error });

    const saved = await db
      .from("platform_release_reviews" as never)
      .update(
        {
          email_sent_at: now.toISOString(),
          email_provider_id: data?.id ?? null,
          email_claimed_at: null,
          email_last_error: null,
        } as never,
      )
      .eq("id" as never, row.id);
    if (saved.error) {
      console.error("[release-review] save sent", saved.error);
      return { ok: false, state: "server_error" };
    }
    return { ok: true, state: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "send_failed";
    console.error("[release-review] send", error);
    await db
      .from("platform_release_reviews" as never)
      .update({ email_claimed_at: null, email_last_error: message } as never)
      .eq("id" as never, row.id);
    return { ok: false, state: "send_failed" };
  }
}
