import "server-only";

import { sendDigestEmail } from "@/shared/ai/agentDigest";
import { claimAiExecutionSlot } from "@/shared/ai/executionLimit";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonDateOffset, salonDayRangeUtc, salonNowMinutes, salonToday } from "@/shared/lib/salonTime";

const CLAIM_FEATURE = "digest_backfill_send";
const MAX_BOOKINGS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type DigestBackfillInput = { salonId: string; reportDate: string };
export type DigestBackfillReason =
  | "invalid_input" | "date_not_eligible" | "salon_unavailable"
  | "salon_disabled" | "recipients_unavailable" | "history_unavailable"
  | "attempt_requires_review" | "stats_unavailable" | "claim_unavailable"
  | "delivery_unverified" | "receipt_unverified";
export type DigestBackfillResult =
  | { status: "ready"; reportDate: string; recipientCount: number }
  | { status: "sent"; reportDate: string; recipientCount: number; providerMessageId: string }
  | { status: "already_sent"; reportDate: string }
  | { status: "blocked" | "failed"; reason: DigestBackfillReason; providerMessageId?: string };

/** Calendar date arithmetic only; UTC here is not the salon's day boundary. */
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function isDigestBackfillDateEligible(reportDate: string, timezone: string, now = new Date()): boolean {
  if (!validDate(reportDate) || !Number.isFinite(now.getTime())) return false;
  try {
    const nowIso = now.toISOString();
    const today = salonToday(timezone, nowIso);
    // The ordinary manager runs at 21:00 local. Recovery cannot race that hour.
    return reportDate === salonDateOffset(timezone, -1, nowIso)
      || (reportDate === today && salonNowMinutes(timezone, nowIso) >= 22 * 60);
  } catch {
    return false;
  }
}

type Salon = {
  name: string;
  slug: string;
  timezone: string;
  archived_at: string | null;
  superadmin_locked_at: string | null;
  feature_flags: Record<string, unknown> | null;
  owner_notification_settings: Record<string, unknown> | null;
};

/**
 * Internal, authenticated-operator recovery primitive, NOT a server action.
 * Caller must authorize and audit before invoking send mode. Read-only preview
 * never claims or sends. Only explicit digest recipients are supported: no
 * silent expansion to all members during an incident recovery.
 *
 * A separate durable execution claim is reused as a conservative attempt guard.
 * It is never released, even after rejection/timeout/receipt failure. Operators
 * must reconcile an ambiguous attempt rather than retry a potentially sent
 * email. The 31-day claim outlives the one-day recovery window and Resend's
 * 24-hour idempotency window; no new migration is needed.
 */
export async function runDigestBackfill(
  input: DigestBackfillInput,
  options: { dryRun?: boolean; expectedRecipientCount?: number } = {},
): Promise<DigestBackfillResult> {
  if (!input || typeof input.salonId !== "string" || !UUID.test(input.salonId)
    || typeof input.reportDate !== "string" || !validDate(input.reportDate)) {
    return { status: "blocked", reason: "invalid_input" };
  }
  const { salonId, reportDate } = input;
  let attempted = false;
  let providerMessageId: string | undefined;
  try {
    const db = createServiceRoleClient({ timeoutMs: 15_000 });
    const { data: row, error: salonError } = await db.from("salons")
      .select("name, slug, timezone, feature_flags, owner_notification_settings, archived_at, superadmin_locked_at")
      .eq("id", salonId).maybeSingle();
    const salon = row as unknown as Salon | null;
    if (salonError || !salon || !salon.name || !salon.slug || !salon.timezone) {
      return { status: "blocked", reason: "salon_unavailable" };
    }
    if (!isDigestBackfillDateEligible(reportDate, salon.timezone)) {
      return { status: "blocked", reason: "date_not_eligible" };
    }
    if (salon.archived_at !== null || salon.superadmin_locked_at !== null
      || salon.feature_flags?.ai_unified_digest !== true
      || salon.owner_notification_settings?.enabled !== true) {
      return { status: "blocked", reason: "salon_disabled" };
    }
    const rawRecipients = salon.owner_notification_settings.digest_emails;
    if (!Array.isArray(rawRecipients) || rawRecipients.length < 1 || rawRecipients.length > 10
      || rawRecipients.some((email: unknown) => typeof email !== "string"
        || email.length > 254 || !EMAIL.test(email))) {
      return { status: "blocked", reason: "recipients_unavailable" };
    }
    const recipientCount = new Set((rawRecipients as string[]).map((email) => email.toLowerCase())).size;
    if (options.expectedRecipientCount !== undefined && options.expectedRecipientCount !== recipientCount) {
      return { status: "blocked", reason: "recipients_unavailable" };
    }

    // Dedupe by report date, not delivery timestamp: a backfill is sent later.
    const [receipt, legacy, attempt] = await Promise.all([
      db.from("ai_digest_deliveries" as never).select("id")
        .eq("salon_id", salonId).eq("digest_date", reportDate).limit(1).maybeSingle(),
      db.from("ai_actions_log" as never).select("id")
        .eq("salon_id", salonId).eq("action_type", "digest_sent")
        .eq("payload->>today", reportDate).limit(1).maybeSingle(),
      db.from("ai_execution_limits" as never).select("dedupe_key")
        .eq("salon_id", salonId).eq("feature", CLAIM_FEATURE)
        .eq("dedupe_key", reportDate).limit(1).maybeSingle(),
    ]);
    if (receipt.error || legacy.error || attempt.error) {
      return { status: "blocked", reason: "history_unavailable" };
    }
    if (receipt.data || legacy.data) return { status: "already_sent", reportDate };
    if (attempt.data) return { status: "blocked", reason: "attempt_requires_review" };

    const { startUtc, endUtc } = salonDayRangeUtc(reportDate, salon.timezone);
    const statsQuery = await db.from("bookings")
      .select("status, price_cents", { count: "exact" })
      .eq("salon_id", salonId).gte("start_time_utc", startUtc).lt("start_time_utc", endUtc)
      .not("status", "eq", "cancelled_before_window").limit(MAX_BOOKINGS);
    const bookings = statsQuery.data as unknown as Array<{ status: string; price_cents: number | null }> | null;
    if (statsQuery.error || !Array.isArray(bookings) || statsQuery.count !== bookings.length
      || bookings.some((booking) => !booking || typeof booking.status !== "string" || !booking.status
        || (booking.status === "completed" && (!Number.isSafeInteger(booking.price_cents) || Number(booking.price_cents) < 0)))) {
      return { status: "blocked", reason: "stats_unavailable" };
    }
    const completed = bookings.filter((booking) => booking.status === "completed");
    const revenueCents = completed.reduce((sum, booking) => sum + Number(booking.price_cents), 0);
    if (!Number.isSafeInteger(revenueCents)) return { status: "blocked", reason: "stats_unavailable" };
    if (options.dryRun) return { status: "ready", reportDate, recipientCount };

    const claimed = await claimAiExecutionSlot({
      salonId, feature: CLAIM_FEATURE, dedupeKey: reportDate,
      windowSeconds: 31 * 24 * 60 * 60, maxCalls: 32,
    });
    if (!claimed) return { status: "blocked", reason: "claim_unavailable" };
    // Never release this guard: even a network exception might follow acceptance.
    attempted = true;
    if (!isDigestBackfillDateEligible(reportDate, salon.timezone)) {
      return { status: "blocked", reason: "date_not_eligible" };
    }
    const body = [
      `Báo cáo gửi bù cho ngày ${reportDate} · ${salon.name}.`,
      `Theo dữ liệu hiện đang lưu cho ngày này, tiệm có ${bookings.length} lịch hẹn; ${completed.length} đã được đánh dấu hoàn thành, ${bookings.filter((booking) => booking.status === "cancelled").length} đã huỷ và ${bookings.filter((booking) => booking.status === "no_show").length} khách không đến.`,
      `Tổng giá trị dịch vụ của các lịch đã đánh dấu hoàn thành: $${(revenueCents / 100).toFixed(2)} theo đơn vị tiền tệ của tiệm. Đây không phải xác nhận tiền đã thu và không bao gồm xác minh thanh toán, thuế hoặc tip.`,
      "Báo cáo được tổng hợp lại tại thời điểm gửi từ các bản ghi hiện có, không phải ảnh chụp dữ liệu tại cuối ngày. Những thay đổi sau ngày báo cáo có thể đã được phản ánh. Báo cáo gửi bù không bao gồm yêu cầu duyệt hiện tại hoặc thay đổi bất kỳ lịch hẹn nào.",
    ].join("\n\n");
    const delivery = await sendDigestEmail(salonId, salon.name, body, reportDate, [], salon.slug, undefined, rawRecipients as string[]);
    if (delivery.status !== "sent") return { status: "failed", reason: "delivery_unverified" };
    providerMessageId = delivery.providerMessageId;
    const { error } = await db.rpc("record_ai_digest_delivery" as never, {
      p_salon_id: salonId, p_digest_date: reportDate,
      p_provider_message_id: providerMessageId, p_sent_at: new Date().toISOString(),
      p_approval_ids: [], p_agents_active: [], p_recipient_count: delivery.recipientCount,
    } as never);
    if (error) return { status: "failed", reason: "receipt_unverified", providerMessageId };
    return { status: "sent", reportDate, recipientCount: delivery.recipientCount, providerMessageId };
  } catch {
    // Never log provider errors, payloads, recipient addresses, or internal tokens.
    return {
      status: "failed",
      reason: providerMessageId ? "receipt_unverified" : attempted ? "delivery_unverified" : "salon_unavailable",
      ...(providerMessageId ? { providerMessageId } : {}),
    };
  }
}
