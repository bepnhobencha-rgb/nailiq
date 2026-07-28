/**
 * AI Salon Manager cron — runs all AI agents for every active salon,
 * independent of Square sync. Called hourly by Vercel Cron (see vercel.json).
 * Secured by CRON_SECRET. Each agent self-throttles/gates internally so calling
 * them hourly is cheap.
 */
import { NextResponse } from "next/server";
import { recordAiWorkerHeartbeat } from "@/shared/ai/executionHeartbeat";
import { summarizeManagerRun } from "@/shared/ai/managerRunSummary";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonNowMinutes } from "@/shared/lib/salonTime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min

export async function GET(req: Request): Promise<NextResponse> {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    return NextResponse.json(
      { ok: false, error: "cron_secret_not_configured" },
      { status: 503 },
    );
  }
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret !== expectedSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const runId = crypto.randomUUID();
  try {
    await recordAiWorkerHeartbeat({
      workerName: "ai_manager",
      runId,
      phase: "started",
      now: new Date(),
    });
  } catch (heartbeatError) {
    console.error("[manager] heartbeat start", heartbeatError);
    return NextResponse.json(
      { ok: false, error: "manager_heartbeat_unavailable" },
      { status: 500 },
    );
  }

  const supabase = createServiceRoleClient();

  // Get all salons — agents internally gate on their own feature_flags, so
  // no need to filter here. Selecting slug for readable result logs.
  const { data: salons, error } = await supabase
    .from("salons")
    .select("id, slug, feature_flags, timezone");

  if (error) {
    console.error("[manager] load salons", error);
    try {
      await recordAiWorkerHeartbeat({
        workerName: "ai_manager",
        runId,
        phase: "failed",
        now: new Date(),
        error: "salon_load_failed",
      });
    } catch (heartbeatError) {
      console.error("[manager] heartbeat failure", heartbeatError);
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!salons?.length) {
    try {
      await recordAiWorkerHeartbeat({
        workerName: "ai_manager",
        runId,
        phase: "succeeded",
        now: new Date(),
        summary: {
          salons: 0,
          agent_runs: 0,
          agent_failures: 0,
          failed_agents: [],
        },
      });
    } catch (heartbeatError) {
      console.error("[manager] heartbeat completion", heartbeatError);
      return NextResponse.json(
        { ok: false, error: "manager_heartbeat_unavailable" },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, salons: 0 });
  }

  const results: Record<string, unknown>[] = [];

  for (const salon of salons) {
    const flags = (salon.feature_flags ?? {}) as Record<string, boolean>;
    const tz = (salon as { timezone?: string }).timezone ?? "America/Los_Angeles";
    const salonHour = Math.floor(salonNowMinutes(tz) / 60);
    const entry: Record<string, unknown> = { salon: salon.slug };

    // Outcome tracker — runs at 09:00, checks if Minh's actions led to bookings
    if (salonHour === 9) {
      try {
        const { runOutcomeTracker } = await import(
          "@/shared/ai/agentOutcomeTracker"
        );
        await runOutcomeTracker(salon.id);
        entry.outcome_tracker = "ok";
      } catch (e) {
        console.error("[manager] outcome_tracker", salon.slug, e);
        entry.outcome_tracker = "failed";
      }

      // Rebuild SIP from live data if stale (>7 days or never built).
      // Keeps the intelligence profile fresh without requiring owner action.
      try {
        const { rebuildSipIfStale } = await import("@/shared/ai/buildSip");
        await rebuildSipIfStale(salon.id);
        entry.sip = "ok";
      } catch (e) {
        console.error("[manager] sip rebuild", salon.slug, e);
        entry.sip = "failed";
      }

      // Cancellation Radar — daily check; spike alert any day, full report on Monday
      try {
        const { runCancellationRadar } = await import("@/shared/ai/agentCancellationRadar");
        await runCancellationRadar(salon.id);
        entry.cancellation_radar = "ok";
      } catch (e) {
        console.error("[manager] cancellation_radar", salon.slug, e);
        entry.cancellation_radar = "failed";
      }

      // Revenue Report + Staff Performance — Monday only, weekly dedup
      const todayAbbr = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        weekday: "short",
      }).format(new Date());
      if (todayAbbr === "Mon") {
        try {
          const { runRevenueReport } = await import("@/shared/ai/agentRevenue");
          await runRevenueReport(salon.id);
          entry.revenue_report = "ok";
        } catch (e) {
          console.error("[manager] revenue_report", salon.slug, e);
          entry.revenue_report = "failed";
        }

        try {
          const { runStaffPerformance } = await import("@/shared/ai/agentStaffPerformance");
          await runStaffPerformance(salon.id);
          entry.staff_performance = "ok";
        } catch (e) {
          console.error("[manager] staff_performance", salon.slug, e);
          entry.staff_performance = "failed";
        }
      }
    }

    // AI no-show policy shadow/live backfill
    if (flags.ai_noshow_policy_shadow || flags.ai_noshow_policy_live) {
      try {
        const { backfillNoShowShadow } = await import(
          "@/shared/noshow/agentNoShowPolicy"
        );
        await backfillNoShowShadow(salon.id);
        entry.noshow = "ok";
      } catch (e) {
        console.error("[manager] noshow backfill", salon.slug, e);
        entry.noshow = "failed";
      }
    }

    // AI Watchdog — proactive owner alerts; self-throttles to ~once/12h
    if (flags.ai_watchdog) {
      try {
        const { runWatchdog } = await import("@/shared/watchdog/agentWatchdog");
        await runWatchdog(salon.id);
        entry.watchdog = "ok";
      } catch (e) {
        console.error("[manager] watchdog", salon.slug, e);
        entry.watchdog = "failed";
      }
    }

    // AI Win-back — draft "we miss you" for lapsed regulars; 30-day dedupe
    if (flags.ai_winback) {
      try {
        const { runWinback } = await import("@/shared/winback/agentWinback");
        await runWinback(salon.id);
        entry.winback = "ok";
      } catch (e) {
        console.error("[manager] winback", salon.slug, e);
        entry.winback = "failed";
      }
    }

    // AI Due-to-Rebook — nudge on-rhythm regulars coming due for next visit
    if (flags.ai_rebook) {
      try {
        const { runRebook } = await import("@/shared/winback/agentRebook");
        await runRebook(salon.id);
        entry.rebook = "ok";
      } catch (e) {
        console.error("[manager] rebook", salon.slug, e);
        entry.rebook = "failed";
      }
    }

    // Báo Cáo Viên — daily report at 21:00; skipped when unified digest is on
    if (salonHour === 21 && !flags.ai_unified_digest) {
      try {
        const { runDailyReport } = await import(
          "@/shared/ai/agentDailyReport"
        );
        await runDailyReport(salon.id);
        entry.daily_report = "ok";
      } catch (e) {
        console.error("[manager] daily_report", salon.slug, e);
        entry.daily_report = "failed";
      }
    }

    // Unified Digest — replaces Báo Cáo Viên + individual agent alerts at 21:00
    if (salonHour === 21 && flags.ai_unified_digest) {
      try {
        const { runDigest } = await import("@/shared/ai/agentDigest");
        await runDigest(salon.id);
        entry.digest = "ok";
      } catch (e) {
        console.error("[manager] digest", salon.slug, e);
        entry.digest = "failed";
      }
    }

    // Social Content — draft caption Mon/Wed/Fri at 08:00 salon local time
    if (salonHour === 8 && flags.ai_social_content) {
      try {
        const { runSocialContent } = await import(
          "@/shared/ai/agentSocialContent"
        );
        await runSocialContent(salon.id);
        entry.social_content = "ok";
      } catch (e) {
        console.error("[manager] social_content", salon.slug, e);
        entry.social_content = "failed";
      }
    }

    // VIP Care — birthday / milestone / inactive nudge at 08:00 salon local time
    if (salonHour === 8 && flags.ai_vip_care) {
      try {
        const { runVipCare } = await import("@/shared/ai/agentVipCare");
        await runVipCare(salon.id);
        entry.vip_care = "ok";
      } catch (e) {
        console.error("[manager] vip_care", salon.slug, e);
        entry.vip_care = "failed";
      }
    }

    // Chiến Lược Gia — weekly strategist on Sunday 21:00 salon local time
    if (salonHour === 21) {
      const todayYmd = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        weekday: "short",
      }).format(new Date());
      if (todayYmd === "Sun") {
        try {
          const { runStrategist } = await import("@/shared/ai/agentStrategist");
          await runStrategist(salon.id);
          entry.strategist = "ok";
        } catch (e) {
          console.error("[manager] strategist", salon.slug, e);
          entry.strategist = "failed";
        }
      }
    }

    // Review Responder — poll Google Reviews every 4 hours (hours 8, 12, 16, 20)
    if ([8, 12, 16, 20].includes(salonHour)) {
      try {
        const { runReviewResponder } = await import(
          "@/shared/ai/agentReviewResponder"
        );
        await runReviewResponder(salon.id);
        entry.review_responder = "ok";
      } catch (e) {
        console.error("[manager] review_responder", salon.slug, e);
        entry.review_responder = "failed";
      }
    }

    // Yelp Review Responder — every 4 hours (same cadence as Google Review Responder)
    if ([8, 12, 16, 20].includes(salonHour) && flags.ai_yelp_reply) {
      try {
        const { runYelpResponder } = await import("@/shared/ai/agentYelpResponder");
        await runYelpResponder(salon.id);
        entry.yelp_responder = "ok";
      } catch (e) {
        console.error("[manager] yelp_responder", salon.slug, e);
        entry.yelp_responder = "failed";
      }
    }

    // Google Business Post — 1st and 15th at 10:00 salon local time; self-dedupes
    if (salonHour === 10 && flags.ai_gbp_post) {
      try {
        const { runGbpPost } = await import("@/shared/ai/agentGoogleBusinessPost");
        await runGbpPost(salon.id);
        entry.gbp_post = "ok";
      } catch (e) {
        console.error("[manager] gbp_post", salon.slug, e);
        entry.gbp_post = "failed";
      }
    }

    // First-visit nurture — runs daily at 20:00 salon time (30 min after Hi-Lite close)
    // Detects same-day first visits so warmth message arrives the same evening
    if (salonHour === 20 && flags.ai_first_visit_nurture) {
      try {
        const { runFirstVisitNurture } = await import(
          "@/shared/firstvisit/agentFirstVisit"
        );
        await runFirstVisitNurture(salon.id);
        entry.first_visit = "ok";
      } catch (e) {
        console.error("[manager] first_visit", salon.slug, e);
        entry.first_visit = "failed";
      }
    }

    results.push(entry);
  }

  const summary = summarizeManagerRun(results);
  const hasFailures = summary.agent_failures > 0;
  try {
    await recordAiWorkerHeartbeat({
      workerName: "ai_manager",
      runId,
      phase: hasFailures ? "failed" : "succeeded",
      now: new Date(),
      summary,
      error: hasFailures ? "manager_agent_failures" : null,
    });
  } catch (heartbeatError) {
    console.error("[manager] heartbeat completion", heartbeatError);
    return NextResponse.json(
      { ok: false, error: "manager_heartbeat_unavailable" },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ok: !hasFailures,
      processed: results.length,
      summary,
      results,
    },
    { status: hasFailures ? 500 : 200 },
  );
}
