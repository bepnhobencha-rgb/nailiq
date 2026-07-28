/**
 * Minh Learning Loop cron — runs daily at 03:00 UTC for all salons.
 * For each salon with AI features enabled:
 *   1. analyzeChannelFailures — if SMS fail rate >50% over 7d, creates a channel lesson
 *   2. analyzeAgentOutcomes  — if agent conversion <5% over 30d, decreases lesson confidence
 *   3. getChannelCostSummary — collect cost data (currently logged; will feed digest)
 *
 * Secured by CRON_SECRET (same as other cron routes).
 */

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { analyzeChannelFailures } from "@/shared/ai/analyzeChannelFailures";
import { analyzeAgentOutcomes } from "@/shared/ai/analyzeOutcomes";
import { getChannelCostSummary } from "@/shared/ai/channelCostTracker";
import { processExpiredAndRemind } from "@/shared/ai/approvalRequests";
import { canRunAutonomousAiForTenant } from "@/shared/ai/tenantExecutionBoundary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min

export async function GET(req: Request): Promise<NextResponse> {
  const expectedSecret = (process.env.CRON_SECRET ?? "").trim();
  if (!expectedSecret) {
    return NextResponse.json(
      { ok: false, error: "cron_secret_not_configured" },
      { status: 503 },
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();

  // Only process salons that have AI features enabled (at least one ai_* flag)
  const { data: salons, error } = await supabase
    .from("salons")
    .select(
      "id, slug, feature_flags, archived_at, superadmin_locked_at, subscription_status",
    );

  if (error) {
    console.error("[minh-learn] load salons", error);
    return NextResponse.json(
      { ok: false, error: "salon_load_failed" },
      { status: 500 },
    );
  }

  const eligibleSalons = (salons ?? []).filter(canRunAutonomousAiForTenant);

  if (!eligibleSalons.length) {
    return NextResponse.json({ ok: true, salons: 0 });
  }

  const results: Record<string, unknown>[] = [];
  let totalLessonsCreated = 0;
  let totalLessonsAdjusted = 0;
  let agentFailures = 0;

  for (const salon of eligibleSalons) {
    const flags = (salon.feature_flags ?? {}) as Record<string, boolean>;
    // Only run for salons with any AI agent enabled
    const hasAiFeature = Object.entries(flags).some(
      ([k, v]) => k.startsWith("ai_") && v === true,
    );
    if (!hasAiFeature) continue;

    const entry: Record<string, unknown> = { salon: salon.slug };

    // 1. Analyze channel (Twilio) failures
    try {
      const channelResult = await analyzeChannelFailures(salon.id);
      entry.channel_failures = {
        smsFailRate: Math.round(channelResult.smsFailRate * 100) + "%",
        lessonCreated: channelResult.lessonCreated,
        lessonId: channelResult.lessonId,
      };
      if (channelResult.lessonCreated) totalLessonsCreated++;
    } catch (e) {
      console.error("[minh-learn] channel_failures", salon.slug, e);
      entry.channel_failures = "failed";
      agentFailures++;
    }

    // 2. Analyze agent outcomes
    try {
      const outcomeResult = await analyzeAgentOutcomes(salon.id);
      entry.outcome_analysis = {
        agents: Object.keys(outcomeResult.agentStats).length,
        lessonsAdjusted: outcomeResult.lessonsAdjusted,
        adaptationsActivated: outcomeResult.adaptationsActivated,
        adaptationsRecovered: outcomeResult.adaptationsRecovered,
      };
      totalLessonsAdjusted += outcomeResult.lessonsAdjusted;
    } catch (e) {
      console.error("[minh-learn] outcome_analysis", salon.slug, e);
      entry.outcome_analysis = "failed";
      agentFailures++;
    }

    // 3. Cost summary (logged; will be incorporated into digest in a future step)
    try {
      const costSummary = await getChannelCostSummary(salon.id);
      entry.cost_summary = {
        smsSent: costSummary.smsSent,
        emailSent: costSummary.emailSent,
        estimatedTotalUsdCents:
          costSummary.estimatedSmsUsdCents + costSummary.estimatedEmailUsdCents,
      };
    } catch (e) {
      console.error("[minh-learn] cost_summary", salon.slug, e);
      entry.cost_summary = "failed";
      agentFailures++;
    }

    results.push(entry);
  }

  // 4. Process expired approval requests + send reminders for stale pending ones
  let expiredApprovals = 0;
  let remindedApprovals = 0;
  try {
    const approvalResult = await processExpiredAndRemind();
    expiredApprovals = approvalResult.expired;
    remindedApprovals = approvalResult.reminded;
  } catch (e) {
    console.error("[minh-learn] approval_requests maintenance", e);
    agentFailures++;
  }

  // Summary log to ai_actions_log (global — salon_id null)
  if (totalLessonsCreated > 0 || totalLessonsAdjusted > 0 || expiredApprovals > 0 || remindedApprovals > 0) {
    await supabase.from("ai_actions_log" as never).insert({
      salon_id: null,
      agent: "minh_self_learn",
      action_type: "daily_learn_summary",
      target_id: null,
      payload: {
        salons_processed: results.length,
        lessons_created: totalLessonsCreated,
        lessons_adjusted: totalLessonsAdjusted,
        approvals_expired: expiredApprovals,
        approvals_reminded: remindedApprovals,
        ran_at: new Date().toISOString(),
      },
    } as never);
  }

  return NextResponse.json(
    {
      ok: agentFailures === 0,
      processed: results.length,
      agentFailures,
      totalLessonsCreated,
      totalLessonsAdjusted,
      expiredApprovals,
      remindedApprovals,
      results,
    },
    { status: agentFailures > 0 ? 500 : 200 },
  );
}
