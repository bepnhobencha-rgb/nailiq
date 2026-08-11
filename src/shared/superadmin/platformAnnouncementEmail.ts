import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import type { UserLanguage } from "@/shared/i18n/user/types";

const CLAIM_LEASE_MS = 10 * 60 * 1_000;
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 25;

type DeliveryRow = {
  id: string;
  announcement_id: string;
  user_id: string;
  status: "queued" | "failed";
  attempt_count: number;
};

type AnnouncementEmailRow = {
  id: string;
  published_at: string | null;
  email_requested: boolean;
  notification_mode: string;
  email_subject_en: string | null;
  email_body_en: string | null;
  email_subject_vi: string | null;
  email_body_vi: string | null;
};

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function buildPlatformAnnouncementEmail(input: {
  subject: string;
  body: string;
  language: UserLanguage;
}): { subject: string; text: string; html: string } {
  const support =
    input.language === "vi"
      ? "Cần hỗ trợ gấp? Gọi 778-868-0738 hoặc email support@nailiq.ca."
      : "Need urgent help? Call 778-868-0738 or email support@nailiq.ca.";
  const body = input.body.trim();
  const alreadyHasSupport =
    body.includes("778-868-0738") && body.includes("support@nailiq.ca");
  const text = alreadyHasSupport ? body : `${body}\n\n${support}`;
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#303030">${esc(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
  return {
    subject: input.subject.trim(),
    text,
    html: `<div style="max-width:560px;margin:0 auto;padding:28px 22px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#171717">
  <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a6a10">NailIQ</p>
  <h1 style="margin:0 0 20px;font-size:23px;line-height:1.3">${esc(input.subject.trim())}</h1>
  ${paragraphs}
</div>`,
  };
}

function languageForMetadata(metadata: Record<string, unknown> | undefined): UserLanguage {
  return metadata?.user_language === "vi" ? "vi" : "en";
}

function copyForLanguage(
  announcement: AnnouncementEmailRow,
  language: UserLanguage,
): { subject: string; body: string } | null {
  const subject =
    language === "vi"
      ? announcement.email_subject_vi?.trim()
      : announcement.email_subject_en?.trim();
  const body =
    language === "vi"
      ? announcement.email_body_vi?.trim()
      : announcement.email_body_en?.trim();
  return subject && body ? { subject, body } : null;
}

async function finish(
  db: SupabaseClient,
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from("platform_announcement_deliveries" as never)
    .update({ ...values, claimed_at: null, updated_at: new Date().toISOString() } as never)
    .eq("id" as never, id);
  if (error) console.error("[announcement-email] finish", error);
}

export async function deliverPendingPlatformAnnouncementEmails(
  db: SupabaseClient,
  now = new Date(),
): Promise<{ claimed: number; sent: number; failed: number; skipped: number }> {
  const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MS).toISOString();
  await db
    .from("platform_announcement_deliveries" as never)
    .update(
      {
        status: "failed",
        claimed_at: null,
        last_error: "claim_expired",
        next_attempt_at: now.toISOString(),
        updated_at: now.toISOString(),
      } as never,
    )
    .eq("status" as never, "sending")
    .lt("claimed_at" as never, staleBefore)
    .lt("attempt_count" as never, MAX_ATTEMPTS);

  const due = (await db
    .from("platform_announcement_deliveries" as never)
    .select("id, announcement_id, user_id, status, attempt_count" as never)
    .in("status" as never, ["queued", "failed"])
    .lt("attempt_count" as never, MAX_ATTEMPTS)
    .lte("next_attempt_at" as never, now.toISOString())
    .order("created_at" as never, { ascending: true })
    .limit(BATCH_SIZE)) as { data: DeliveryRow[] | null; error: unknown };

  if (due.error) throw new Error("announcement_delivery_query_failed");

  let claimedCount = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of due.data ?? []) {
    const claim = (await db
      .from("platform_announcement_deliveries" as never)
      .update(
        {
          status: "sending",
          claimed_at: now.toISOString(),
          attempt_count: row.attempt_count + 1,
          last_error: null,
          updated_at: now.toISOString(),
        } as never,
      )
      .eq("id" as never, row.id)
      .eq("status" as never, row.status)
      .eq("attempt_count" as never, row.attempt_count)
      .select("id" as never)
      .maybeSingle()) as { data: { id: string } | null; error: unknown };
    if (claim.error || !claim.data) continue;
    claimedCount += 1;

    try {
      const announcementResult = (await db
        .from("platform_announcements")
        .select(
          "id, published_at, email_requested, notification_mode, email_subject_en, email_body_en, email_subject_vi, email_body_vi" as never,
        )
        .eq("id", row.announcement_id)
        .maybeSingle()) as { data: AnnouncementEmailRow | null; error: unknown };
      const announcement = announcementResult.data;
      if (
        announcementResult.error ||
        !announcement?.published_at ||
        !announcement.email_requested ||
        announcement.notification_mode !== "important"
      ) {
        await finish(db, row.id, { status: "cancelled", last_error: null });
        skipped += 1;
        continue;
      }

      const userResult = await db.auth.admin.getUserById(row.user_id);
      const email = userResult.data.user?.email?.trim().toLowerCase();
      if (userResult.error || !email) {
        await finish(db, row.id, { status: "skipped", last_error: "account_email_missing" });
        skipped += 1;
        continue;
      }
      const language = languageForMetadata(
        userResult.data.user?.user_metadata as Record<string, unknown> | undefined,
      );
      const localized = copyForLanguage(announcement, language);
      if (!localized) {
        await finish(db, row.id, { status: "skipped", language, last_error: "localized_copy_missing" });
        skipped += 1;
        continue;
      }

      const resend = getResendClient();
      if (!resend) throw new Error("email_provider_unavailable");
      const message = buildPlatformAnnouncementEmail({ ...localized, language });
      const result = await resend.emails.send(
        {
          from: getResendFrom(),
          to: email,
          subject: message.subject,
          text: message.text,
          html: message.html,
        },
        { idempotencyKey: `nailiq-platform-notice-${row.announcement_id}-${row.user_id}` },
      );
      if (result.error) throw new Error("email_provider_rejected");

      await finish(db, row.id, {
        status: "sent",
        language,
        sent_at: now.toISOString(),
        provider_id: result.data?.id ?? null,
        last_error: null,
      });
      sent += 1;
    } catch (error) {
      const nextAttempt = new Date(
        now.getTime() + (row.attempt_count === 0 ? 60_000 : 5 * 60_000),
      ).toISOString();
      await finish(db, row.id, {
        status: "failed",
        next_attempt_at: nextAttempt,
        last_error:
          error instanceof Error && error.message === "email_provider_unavailable"
            ? "email_provider_unavailable"
            : "delivery_failed",
      });
      failed += 1;
    }
  }

  return { claimed: claimedCount, sent, failed, skipped };
}
