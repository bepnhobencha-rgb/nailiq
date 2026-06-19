import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { createLesson } from "./lessonMutations";

const MIN_SAMPLE_SIZE = 5; // ignore if fewer than this many sends
const FAIL_RATE_THRESHOLD = 0.5; // 50% failure rate triggers a lesson

export type ChannelFailureResult = {
  smsFailRate: number;
  lessonCreated: boolean;
  lessonId: string | null;
};

/**
 * Analyzes recent Twilio failures for a salon over the last 7 days.
 * If SMS fail rate exceeds threshold and there's enough signal:
 *   - Creates a 'channel' lesson instructing agents to prefer email.
 *   - Logs the action to ai_actions_log.
 *
 * Idempotent: skips lesson creation if an active channel lesson already exists
 * for this salon with fail_rate_sms=true.
 */
export async function analyzeChannelFailures(
  salonId: string,
): Promise<ChannelFailureResult> {
  const db = createServiceRoleClient();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();

  // Count SMS sends and failures for this salon in last 7 days
  const { data: rows, error } = await db
    .from("booking_notifications" as never)
    .select("status, error_code")
    .eq("salon_id" as never, salonId)
    .eq("channel" as never, "sms")
    .gte("created_at" as never, since);

  if (error) {
    console.error("[analyzeChannelFailures] query", salonId, error);
    return { smsFailRate: 0, lessonCreated: false, lessonId: null };
  }

  const allRows = (rows ?? []) as { status: string; error_code: string | null }[];
  const total = allRows.length;

  if (total < MIN_SAMPLE_SIZE) {
    // Not enough signal
    return { smsFailRate: 0, lessonCreated: false, lessonId: null };
  }

  const failedCount = allRows.filter(
    (r) =>
      r.status === "failed" ||
      r.error_code === "30034" ||
      r.error_code === "30007",
  ).length;

  const smsFailRate = failedCount / total;

  if (smsFailRate <= FAIL_RATE_THRESHOLD) {
    return { smsFailRate, lessonCreated: false, lessonId: null };
  }

  // Check if an active channel lesson already exists for this salon
  const { data: existing } = await db
    .from("minh_lessons" as never)
    .select("id")
    .eq("scope" as never, "channel")
    .eq("active" as never, true)
    .or(`salon_id.is.null,salon_id.eq.${salonId}` as never)
    .contains("condition" as never, { fail_rate_sms: true } as never)
    .limit(1)
    .maybeSingle();

  if (existing) {
    // Lesson already exists — no duplicate
    return {
      smsFailRate,
      lessonCreated: false,
      lessonId: (existing as { id: string }).id,
    };
  }

  // Create the lesson
  const failPct = Math.round(smsFailRate * 100);
  const lessonId = await createLesson({
    salonId,
    scope: "channel",
    condition: { fail_rate_sms: true },
    rule: `prefer_email: High SMS failure rate (${failPct}%) in last 7d — route to email`,
    source: "auto:twilio_fail_analysis",
    confidence: 0.8,
  });

  // Log to ai_actions_log
  await db.from("ai_actions_log" as never).insert({
    salon_id: salonId,
    agent: "minh_self_learn",
    action_type: "lesson_created",
    target_id: lessonId,
    payload: {
      fail_rate: smsFailRate,
      total_sms: total,
      failed_sms: failedCount,
      lesson_id: lessonId,
    },
  } as never);

  return { smsFailRate, lessonCreated: true, lessonId };
}
