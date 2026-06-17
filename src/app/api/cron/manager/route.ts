/**
 * AI Salon Manager cron — runs all AI agents for every active salon,
 * independent of Square sync. Called hourly by Vercel Cron (see vercel.json).
 * Secured by CRON_SECRET. Each agent self-throttles/gates internally so calling
 * them hourly is cheap.
 */
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonNowMinutes } from "@/shared/lib/salonTime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min

export async function GET(req: Request): Promise<NextResponse> {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();

  // Get all salons — agents internally gate on their own feature_flags, so
  // no need to filter here. Selecting slug for readable result logs.
  const { data: salons, error } = await supabase
    .from("salons")
    .select("id, slug, feature_flags, timezone");

  if (error) {
    console.error("[manager] load salons", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!salons?.length) return NextResponse.json({ ok: true, salons: 0 });

  const results: Record<string, unknown>[] = [];

  for (const salon of salons) {
    const flags = (salon.feature_flags ?? {}) as Record<string, boolean>;
    const tz = (salon as { timezone?: string }).timezone ?? "America/Los_Angeles";
    const salonHour = Math.floor(salonNowMinutes(tz) / 60);
    const entry: Record<string, unknown> = { salon: salon.slug };

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
        entry.noshow = String(e);
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
        entry.watchdog = String(e);
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
        entry.winback = String(e);
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
        entry.rebook = String(e);
      }
    }

    // Báo Cáo Viên — daily report at 21:00 salon local time
    if (salonHour === 21) {
      try {
        const { runDailyReport } = await import(
          "@/shared/ai/agentDailyReport"
        );
        await runDailyReport(salon.id);
        entry.daily_report = "ok";
      } catch (e) {
        console.error("[manager] daily_report", salon.slug, e);
        entry.daily_report = String(e);
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
        entry.social_content = String(e);
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
        entry.vip_care = String(e);
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
        entry.review_responder = String(e);
      }
    }

    results.push(entry);
  }

  return NextResponse.json({ ok: true, processed: results.length, results });
}
