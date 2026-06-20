import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendOwnerAlert } from "@/shared/ai/sendOwnerAlert";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";

/**
 * Agent Doanh Thu (Weekly Revenue Report) — Runs every Monday at 09:00.
 *
 * Gathers last-7-days revenue by service, avg ticket, no-show exposure,
 * compares to prior week, and asks Haiku for one actionable insight.
 * Sends a standalone email (suppressed when ai_unified_digest is ON, but
 * always logs to ai_actions_log so the digest picks up the payload).
 *
 * Feature flag: ai_revenue_report
 * Dedup: once per week (skips if already ran in last 6 days).
 */

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

let _ai: Anthropic | null = null;
function getAI(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!_ai) _ai = new Anthropic({ apiKey: key });
  return _ai;
}

// ── Data collection ───────────────────────────────────────────────────────────

type ServiceStat = { name: string; count: number; revenueCents: number };

type WeekRevenue = {
  totalRevenueCents: number;
  completedCount: number;
  avgTicketCents: number;
  noShowCount: number;
  noShowWithCardCount: number;
  services: ServiceStat[];
};

async function gatherWeekRevenue(salonId: string, weeksAgo: number): Promise<WeekRevenue> {
  const db = looseServiceClient();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const start = new Date(Date.now() - (weeksAgo + 1) * weekMs).toISOString();
  const end = new Date(Date.now() - weeksAgo * weekMs).toISOString();

  const { data } = await db
    .from("bookings" as never)
    .select("status, price_cents, noshow_card_id, service:service_id(name)" as never)
    .eq("salon_id" as never, salonId)
    .gte("start_time_utc" as never, start)
    .lt("start_time_utc" as never, end)
    .in("status" as never, ["completed", "no_show"]);

  const rows = (data ?? []) as Row[];
  const completed = rows.filter((r) => str(r.status) === "completed");
  const noShows = rows.filter((r) => str(r.status) === "no_show");

  const totalRevenueCents = completed.reduce((s, r) => s + num(r.price_cents), 0);
  const completedCount = completed.length;
  const avgTicketCents = completedCount > 0 ? Math.round(totalRevenueCents / completedCount) : 0;

  const svcMap = new Map<string, { count: number; revenueCents: number }>();
  for (const r of completed) {
    const name = str((r.service as Record<string, unknown> | null)?.name) || "Other";
    const ex = svcMap.get(name) ?? { count: 0, revenueCents: 0 };
    svcMap.set(name, { count: ex.count + 1, revenueCents: ex.revenueCents + num(r.price_cents) });
  }
  const services: ServiceStat[] = Array.from(svcMap.entries())
    .map(([name, { count, revenueCents }]) => ({ name, count, revenueCents }))
    .sort((a, b) => b.revenueCents - a.revenueCents)
    .slice(0, 8);

  return {
    totalRevenueCents,
    completedCount,
    avgTicketCents,
    noShowCount: noShows.length,
    noShowWithCardCount: noShows.filter((r) => r.noshow_card_id != null).length,
    services,
  };
}

// ── AI insight ────────────────────────────────────────────────────────────────

type RevenueInsight = { summary: string; recommendation: string };

async function analyzeRevenue(
  salonName: string,
  lang: "vi" | "en",
  thisWeek: WeekRevenue,
  lastWeek: WeekRevenue,
): Promise<RevenueInsight | null> {
  const ai = getAI();
  if (!ai) return null;

  const changePct = (a: number, b: number) =>
    b === 0 ? "N/A" : `${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%`;

  const noShowExposure = Math.round(
    (thisWeek.noShowCount - thisWeek.noShowWithCardCount) * (thisWeek.avgTicketCents / 100),
  );

  const svcLines = thisWeek.services
    .slice(0, 5)
    .map((s) => `  ${s.name}: ${s.count} lịch · $${(s.revenueCents / 100).toFixed(0)}`)
    .join("\n");

  const context = `Salon: ${salonName}
Tuần này: $${(thisWeek.totalRevenueCents / 100).toFixed(0)} doanh thu · ${thisWeek.completedCount} lịch · ticket TB $${(thisWeek.avgTicketCents / 100).toFixed(0)}
Tuần trước: $${(lastWeek.totalRevenueCents / 100).toFixed(0)} · ${lastWeek.completedCount} lịch · ticket TB $${(lastWeek.avgTicketCents / 100).toFixed(0)}
So sánh: Doanh thu ${changePct(thisWeek.totalRevenueCents, lastWeek.totalRevenueCents)} · Lịch ${changePct(thisWeek.completedCount, lastWeek.completedCount)} · Ticket ${changePct(thisWeek.avgTicketCents, lastWeek.avgTicketCents)}
No-show: ${thisWeek.noShowCount} (${thisWeek.noShowWithCardCount} có thẻ · ~$${noShowExposure} bỏ lỡ nếu không có thẻ)
Dịch vụ (theo doanh thu):\n${svcLines || "  (không có dữ liệu)"}`;

  const prompt = `Bạn là quản lý tài chính cho salon "${salonName}". Nhận xét tuần vừa qua bằng ${lang === "vi" ? "tiếng Việt" : "English"}.
${context}
Trả JSON với 2 trường:
- "summary": 1-2 câu tóm tắt hiệu quả tài chính (nêu số thật, so sánh tuần trước)
- "recommendation": 1 câu gợi ý cụ thể nhất dựa trên data
Chỉ trả JSON, không markdown.`;

  try {
    const resp = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    const cleaned = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as RevenueInsight;
    return parsed.summary ? parsed : null;
  } catch (e) {
    console.error("[agentRevenue] AI error", e);
    return null;
  }
}

// ── Email ─────────────────────────────────────────────────────────────────────

function buildRevenueEmail(
  salonName: string,
  thisWeek: WeekRevenue,
  lastWeek: WeekRevenue,
  insight: RevenueInsight,
): { subject: string; bodyText: string; bodyHtml: string } {
  const esc = (x: string) =>
    x.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));

  const arrow = (a: number, b: number) => {
    if (b === 0) return "";
    const p = Math.round(((a - b) / b) * 100);
    const col = p >= 0 ? "#16a34a" : "#dc2626";
    return ` <span style="color:${col};font-size:11px">${p >= 0 ? "▲" : "▼"}${Math.abs(p)}%</span>`;
  };

  const noShowExposure = Math.round(
    (thisWeek.noShowCount - thisWeek.noShowWithCardCount) * (thisWeek.avgTicketCents / 100),
  );

  const svcRows = thisWeek.services
    .slice(0, 6)
    .map(
      (s) =>
        `<tr>
          <td style="padding:5px 12px 5px 0;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6">${esc(s.name)}</td>
          <td style="padding:5px 0;font-size:13px;text-align:right;color:#6b7280;border-bottom:1px solid #f3f4f6">${s.count} lịch</td>
          <td style="padding:5px 0 5px 12px;font-size:13px;text-align:right;font-weight:600;border-bottom:1px solid #f3f4f6">$${(s.revenueCents / 100).toFixed(0)}</td>
        </tr>`,
    )
    .join("");

  const noShowHtml =
    thisWeek.noShowCount > 0
      ? `<div style="background:#fef3c7;border-radius:8px;padding:12px 14px;margin:16px 0">
          <p style="font-size:13px;font-weight:600;color:#92400e;margin:0 0 3px">No-show tuần này: ${thisWeek.noShowCount}</p>
          <p style="font-size:12px;color:#92400e;margin:0">${thisWeek.noShowWithCardCount} có thẻ bảo vệ · ${thisWeek.noShowCount - thisWeek.noShowWithCardCount} không thẻ (~$${noShowExposure} phí bỏ lỡ)</p>
        </div>`
      : "";

  const bodyHtml = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:540px;color:#1a1a1a;padding:8px">
  <p style="font-size:11px;color:#999;margin:0 0 12px;text-transform:uppercase;letter-spacing:.08em">Báo Cáo Doanh Thu Tuần · ${esc(salonName)}</p>

  <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
    <tr>
      <td style="padding:12px;background:#f9fafb;border-radius:8px;text-align:center;width:33%">
        <p style="font-size:11px;color:#6b7280;margin:0 0 4px">Doanh Thu</p>
        <p style="font-size:20px;font-weight:700;margin:0">$${(thisWeek.totalRevenueCents / 100).toFixed(0)}${arrow(thisWeek.totalRevenueCents, lastWeek.totalRevenueCents)}</p>
      </td>
      <td style="width:8px"></td>
      <td style="padding:12px;background:#f9fafb;border-radius:8px;text-align:center;width:33%">
        <p style="font-size:11px;color:#6b7280;margin:0 0 4px">Lịch Xong</p>
        <p style="font-size:20px;font-weight:700;margin:0">${thisWeek.completedCount}${arrow(thisWeek.completedCount, lastWeek.completedCount)}</p>
      </td>
      <td style="width:8px"></td>
      <td style="padding:12px;background:#f9fafb;border-radius:8px;text-align:center;width:33%">
        <p style="font-size:11px;color:#6b7280;margin:0 0 4px">Ticket TB</p>
        <p style="font-size:20px;font-weight:700;margin:0">$${(thisWeek.avgTicketCents / 100).toFixed(0)}${arrow(thisWeek.avgTicketCents, lastWeek.avgTicketCents)}</p>
      </td>
    </tr>
  </table>

  <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 16px">${esc(insight.summary)}</p>

  ${
    thisWeek.services.length > 0
      ? `<p style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin:0 0 6px">Dịch Vụ Tuần Này</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:0">${svcRows}</table>`
      : ""
  }

  ${noShowHtml}

  <div style="border-left:3px solid #2563eb;padding:10px 14px;background:#eff6ff;border-radius:0 8px 8px 0;margin-top:16px">
    <p style="font-size:11px;font-weight:700;color:#1d4ed8;margin:0 0 3px;text-transform:uppercase;letter-spacing:.05em">💡 Gợi ý tuần tới</p>
    <p style="font-size:13px;color:#1e40af;margin:0">${esc(insight.recommendation)}</p>
  </div>

  <p style="font-size:11px;color:#aaa;margin-top:20px">— Quản Lý AI · ${esc(salonName)}</p>
</div>`;

  const bodyText = `${salonName} — Doanh Thu Tuần\n\nDoanh thu: $${(thisWeek.totalRevenueCents / 100).toFixed(0)} | Lịch: ${thisWeek.completedCount} | Ticket TB: $${(thisWeek.avgTicketCents / 100).toFixed(0)}\n\n${insight.summary}\n\nGợi ý: ${insight.recommendation}`;

  return {
    subject: `${salonName} · Doanh Thu Tuần: $${(thisWeek.totalRevenueCents / 100).toFixed(0)}`,
    bodyText,
    bodyHtml,
  };
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

async function alreadyRanThisWeek(salonId: string): Promise<boolean> {
  const db = createServiceRoleClient();
  const since = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from("ai_actions_log" as never)
    .select("id" as never)
    .eq("salon_id" as never, salonId)
    .eq("agent" as never, "revenue_report")
    .gte("created_at" as never, since)
    .limit(1);
  return ((data ?? []) as unknown[]).length > 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runRevenueReport(salonId: string): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons" as never)
      .select("name, timezone, feature_flags, ai_profile" as never)
      .eq("id" as never, salonId)
      .maybeSingle();

    const s = (salon as Row | null) ?? {};
    const flags = (s.feature_flags as Record<string, boolean> | null) ?? {};
    if (!flags.ai_revenue_report) return;
    if (await alreadyRanThisWeek(salonId)) return;

    const salonName = str(s.name) || "our salon";
    const sip = (s.ai_profile as Partial<SalonIntelligenceProfile> | null) ?? null;
    const lang: "vi" | "en" = sip?.language_primary === "vi" ? "vi" : "en";

    const [thisWeek, lastWeek] = await Promise.all([
      gatherWeekRevenue(salonId, 0),
      gatherWeekRevenue(salonId, 1),
    ]);
    if (thisWeek.completedCount < 3) return;

    const changeVsLastWeekPct =
      lastWeek.totalRevenueCents > 0
        ? Math.round(
            ((thisWeek.totalRevenueCents - lastWeek.totalRevenueCents) / lastWeek.totalRevenueCents) * 100,
          )
        : 0;

    const insight = await analyzeRevenue(salonName, lang, thisWeek, lastWeek);
    if (!insight) return;

    const { subject, bodyText, bodyHtml } = buildRevenueEmail(salonName, thisWeek, lastWeek, insight);
    await sendOwnerAlert(salonId, { subject, bodyText, bodyHtml });

    const svc = createServiceRoleClient();
    await svc.from("ai_actions_log" as never).insert({
      salon_id: salonId,
      agent: "revenue_report",
      action_type: "weekly_revenue_summary",
      target_id: null,
      payload: {
        revenueCents: thisWeek.totalRevenueCents,
        avgTicketCents: thisWeek.avgTicketCents,
        completedCount: thisWeek.completedCount,
        noShowCount: thisWeek.noShowCount,
        noShowWithCardCount: thisWeek.noShowWithCardCount,
        topService: thisWeek.services[0]?.name ?? null,
        changeVsLastWeekPct,
        summary: insight.summary,
      },
      undo_deadline: null,
    } as never);

    console.log(`[revenue_report] ${salonName}: $${(thisWeek.totalRevenueCents / 100).toFixed(0)} this week (${changeVsLastWeekPct >= 0 ? "+" : ""}${changeVsLastWeekPct}%)`);
  } catch (e) {
    console.error("[runRevenueReport]", e);
  }
}
