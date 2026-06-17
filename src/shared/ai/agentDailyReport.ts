"use server";
import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonToday, salonDayRangeUtc } from "@/shared/lib/salonTime";
import { defaultSip } from "./defaultSip";
import { sendOwnerAlert } from "./sendOwnerAlert";
import type { SalonIntelligenceProfile } from "./types";

/**
 * Báo Cáo Viên — AI daily report sent to owner at 21:00 salon local time.
 * Called from /api/cron/manager once per hour; self-throttles to one send
 * per salon per day via ai_actions_log.
 *
 * Model: claude-haiku-4-5 (high-volume, read-only, cheap)
 * Mức tự động: AUTO (no undo window — it's just a report)
 */

let _anthropic: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

type DailyStats = {
  total: number;
  completed: number;
  noShow: number;
  cancelled: number;
  revenueCents: number;
  newClients: number;
  tomorrowCount: number;
};

async function collectStats(
  salonId: string,
  tz: string,
): Promise<DailyStats> {
  const db = createServiceRoleClient();
  const todayYmd = salonToday(tz);
  const { startUtc: todayStart, endUtc: todayEnd } = salonDayRangeUtc(todayYmd, tz);

  const tomorrowEnd = new Date(todayEnd);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

  const [todayRes, tomorrowRes] = await Promise.all([
    db
      .from("bookings")
      .select("status, price_cents, created_at, client_profile_id")
      .eq("salon_id", salonId)
      .gte("start_time_utc", todayStart)
      .lt("start_time_utc", todayEnd)
      .not("status", "eq", "cancelled_before_window"),
    db
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("salon_id", salonId)
      .gte("start_time_utc", todayEnd)
      .lt("start_time_utc", tomorrowEnd.toISOString())
      .not("status", "in", '("cancelled","no_show","cancelled_before_window")'),
  ]);

  const rows = (todayRes.data ?? []) as {
    status: string;
    price_cents: number | null;
    created_at: string;
    client_profile_id: string | null;
  }[];

  const total = rows.length;
  const completed = rows.filter((r) => r.status === "completed").length;
  const noShow = rows.filter((r) => r.status === "no_show").length;
  const cancelled = rows.filter((r) =>
    ["cancelled", "cancelled_before_window"].includes(r.status),
  ).length;
  const revenueCents = rows
    .filter((r) => r.status === "completed")
    .reduce((s, r) => s + (r.price_cents ?? 0), 0);

  // Count bookings created today with a client_profile_id that was first seen today
  // (proxy for new clients — not perfect, but avoids a heavy join)
  const newClients = rows.filter(
    (r) =>
      r.client_profile_id &&
      r.created_at >= todayStart &&
      r.created_at < todayEnd,
  ).length;

  return {
    total,
    completed,
    noShow,
    cancelled,
    revenueCents,
    newClients,
    tomorrowCount: tomorrowRes.count ?? 0,
  };
}

async function alreadySentToday(salonId: string, tz: string): Promise<boolean> {
  const db = createServiceRoleClient();
  const todayYmd = salonToday(tz);
  const { startUtc: todayStart } = salonDayRangeUtc(todayYmd, tz);
  const { count } = await db
    .from("ai_actions_log")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", salonId)
    .eq("agent", "daily_report")
    .gte("created_at", todayStart);
  return (count ?? 0) > 0;
}

async function logAction(
  salonId: string,
  stats: DailyStats,
  summary: string,
): Promise<void> {
  const db = createServiceRoleClient();
  await db.from("ai_actions_log").insert({
    salon_id: salonId,
    agent: "daily_report",
    action_type: "sent_report",
    payload: { stats, summary },
  });
}

function buildPrompt(
  salonName: string,
  sip: SalonIntelligenceProfile,
  stats: DailyStats,
  todayYmd: string,
): string {
  const revenue = (stats.revenueCents / 100).toFixed(2);
  const lang = sip.language_primary === "vi" ? "Vietnamese" : "English";

  return `You are NailIQ, an AI salon manager. Write a brief, warm daily briefing for the owner of ${salonName}.

Date: ${todayYmd}

TODAY'S ACTIVITY:
- Total bookings: ${stats.total}
- Completed: ${stats.completed}
- No-shows: ${stats.noShow}
- Cancelled: ${stats.cancelled}
- Estimated revenue: $${revenue} (catalog prices)
- New clients seen today: ${stats.newClients}

TOMORROW:
- Bookings already scheduled: ${stats.tomorrowCount}

TONE: ${sip.brand_voice === "luxury_formal" ? "professional and polished" : sip.brand_voice === "friendly_fun" ? "casual and upbeat" : "warm and professional"}
LANGUAGE: Write in ${lang}. Be concise — 4 to 5 lines only. No bullet points, no markdown. End with one forward-looking note about tomorrow.`;
}

export async function runDailyReport(
  salonId: string,
  opts?: { force?: boolean },
): Promise<void> {
  try {
    const db = createServiceRoleClient();
    const { data: salonRow } = await db
      .from("salons")
      .select("name, timezone, language, ai_profile" as never)
      .eq("id", salonId)
      .maybeSingle();
    const salon = salonRow as {
      name: string | null;
      timezone: string | null;
      language: string | null;
      ai_profile: SalonIntelligenceProfile | null;
    } | null;
    if (!salon) return;

    const tz = salon.timezone ?? "America/Los_Angeles";

    // Throttle: skip if already sent today (unless forced by test)
    if (!opts?.force && (await alreadySentToday(salonId, tz))) return;

    const sip = defaultSip({
      ai_profile: salon.ai_profile,
      language: salon.language,
    });

    const [stats, ai] = await Promise.all([
      collectStats(salonId, tz),
      Promise.resolve(getClient()),
    ]);

    const todayYmd = salonToday(tz);
    const salonName = salon.name?.trim() || "Your salon";

    let summary: string;
    if (!ai) {
      // Fallback: structured text when no AI key
      const rev = (stats.revenueCents / 100).toFixed(2);
      summary =
        sip.language_primary === "vi"
          ? `Báo cáo ngày ${todayYmd} — ${salonName}\n` +
            `Hôm nay: ${stats.total} lịch hẹn, ${stats.completed} hoàn thành, ${stats.noShow} no-show.\n` +
            `Doanh thu ước tính: $${rev}. Ngày mai: ${stats.tomorrowCount} lịch đã đặt.`
          : `Daily summary ${todayYmd} — ${salonName}\n` +
            `Today: ${stats.total} bookings, ${stats.completed} completed, ${stats.noShow} no-shows.\n` +
            `Est. revenue: $${rev}. Tomorrow: ${stats.tomorrowCount} bookings scheduled.`;
    } else {
      const msg = await ai.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: buildPrompt(salonName, sip, stats, todayYmd),
          },
        ],
      });
      summary =
        msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
    }

    if (!summary) return;

    const rev = (stats.revenueCents / 100).toFixed(2);
    const subjectEn = `${salonName} — Daily summary ${todayYmd}`;
    const subjectVi = `${salonName} — Báo cáo ngày ${todayYmd}`;
    const subject =
      sip.language_primary === "vi"
        ? subjectVi
        : subjectEn;

    const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;max-width:520px">
  <h2 style="font-size:16px;margin:0 0 12px;color:#1a1a1a">${subject}</h2>
  <div style="background:#f8f8f8;border-radius:8px;padding:16px;font-size:14px;line-height:1.7;white-space:pre-wrap;color:#1a1a1a">${summary.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))}</div>
  <table style="border-collapse:collapse;font-size:12px;color:#666;margin-top:16px;width:100%">
    <tr>
      <td style="padding:2px 16px 2px 0">Bookings</td>
      <td style="font-weight:600;color:#1a1a1a">${stats.total} (${stats.completed} done · ${stats.noShow} no-show)</td>
    </tr>
    <tr>
      <td style="padding:2px 16px 2px 0">Est. revenue</td>
      <td style="font-weight:600;color:#1a1a1a">$${rev}</td>
    </tr>
    <tr>
      <td style="padding:2px 16px 2px 0">Tomorrow</td>
      <td style="font-weight:600;color:#1a1a1a">${stats.tomorrowCount} scheduled</td>
    </tr>
  </table>
  <p style="font-size:11px;color:#999;margin-top:16px">NailIQ AI Manager · ${salonName}</p>
</div>`;

    const smsText =
      `${salonName} ${todayYmd}: ${stats.completed}/${stats.total} bookings done` +
      (stats.noShow > 0 ? `, ${stats.noShow} no-show` : "") +
      `. $${rev} rev. Tomorrow: ${stats.tomorrowCount}. ${summary.split("\n")[0]}`;

    await Promise.all([
      sendOwnerAlert(salonId, { subject, bodyText: smsText, bodyHtml: html }),
      logAction(salonId, stats, summary),
    ]);
  } catch (e) {
    console.error("[agentDailyReport]", salonId, e);
  }
}
