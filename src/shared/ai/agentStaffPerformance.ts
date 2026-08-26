import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { createTextBackgroundAnthropicClient } from "@/shared/ai/anthropicProviderPolicy";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendOwnerAlert } from "@/shared/ai/sendOwnerAlert";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";
import { trackAnthropicMessage } from "@/shared/ai/usageLedger";

/**
 * Agent Nhân Viên (Weekly Staff Performance Report) — Runs every Monday at 09:00.
 *
 * Per-staff breakdown: completed bookings, no-show rate, revenue contribution.
 * Flags staff with >20% no-show rate or unexpectedly absent (had bookings last
 * week, zero this week). Haiku writes a short manager summary.
 *
 * Feature flag: ai_staff_performance
 * Dedup: once per week.
 */

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

let _ai: Anthropic | null = null;
function getAI(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!_ai) _ai = createTextBackgroundAnthropicClient(key);
  return _ai;
}

// ── Data collection ───────────────────────────────────────────────────────────

type StaffStat = {
  staffId: string;
  name: string;
  completed: number;
  noShow: number;
  cancelled: number;
  revenueCents: number;
  noShowRate: number; // 0–100
};

async function gatherStaffStats(
  salonId: string,
  weeksAgo: number,
): Promise<StaffStat[]> {
  const db = looseServiceClient();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const start = new Date(Date.now() - (weeksAgo + 1) * weekMs).toISOString();
  const end = new Date(Date.now() - weeksAgo * weekMs).toISOString();

  const { data } = await db
    .from("bookings" as never)
    .select("status, price_cents, staff_id, staff:staff_id(name)" as never)
    .eq("salon_id" as never, salonId)
    .gte("start_time_utc" as never, start)
    .lt("start_time_utc" as never, end)
    .in("status" as never, ["completed", "no_show", "cancelled", "cancelled_before_window"]);

  const rows = (data ?? []) as Row[];
  const map = new Map<string, StaffStat>();

  for (const r of rows) {
    const staffId = str(r.staff_id);
    if (!staffId) continue;
    const staffName = str((r.staff as Record<string, unknown> | null)?.name) || "Unknown";
    if (!map.has(staffId)) {
      map.set(staffId, {
        staffId,
        name: staffName,
        completed: 0,
        noShow: 0,
        cancelled: 0,
        revenueCents: 0,
        noShowRate: 0,
      });
    }
    const stat = map.get(staffId)!;
    const status = str(r.status);
    if (status === "completed") {
      stat.completed++;
      stat.revenueCents += num(r.price_cents);
    } else if (status === "no_show") {
      stat.noShow++;
    } else {
      stat.cancelled++;
    }
  }

  return Array.from(map.values())
    .map((s) => {
      const total = s.completed + s.noShow;
      return { ...s, noShowRate: total > 0 ? Math.round((s.noShow / total) * 100) : 0 };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents);
}

// ── AI summary ────────────────────────────────────────────────────────────────

type StaffInsight = { summary: string; alerts: string[] };

async function analyzeStaff(
  salonId: string,
  salonName: string,
  lang: "vi" | "en",
  thisWeek: StaffStat[],
  absentStaff: string[],
): Promise<StaffInsight | null> {
  const ai = getAI();
  if (!ai) return null;

  const lines = thisWeek
    .map(
      (s) =>
        `  ${s.name}: ${s.completed} hoàn thành · $${(s.revenueCents / 100).toFixed(0)} · no-show ${s.noShowRate}%${s.noShowRate > 20 ? " ⚠️" : ""}`,
    )
    .join("\n");

  const absentLine =
    absentStaff.length > 0
      ? `\nKhông có lịch tuần này (có lịch tuần trước): ${absentStaff.join(", ")}`
      : "";

  const prompt = `Bạn là quản lý nhân sự của salon "${salonName}". Nhận xét hiệu suất nhân viên tuần qua bằng ${lang === "vi" ? "tiếng Việt" : "English"}.

Hiệu suất tuần này:
${lines || "  (không có dữ liệu)"}${absentLine}

Trả JSON:
- "summary": 1-2 câu nhận xét tổng quan nhân viên tuần này
- "alerts": mảng string, mỗi phần tử 1 câu cảnh báo cụ thể (ví dụ nhân viên nào no-show cao, ai vắng). Nếu không có gì đáng lo → mảng rỗng.

Chỉ trả JSON, không markdown.`;

  try {
    const model = "claude-haiku-4-5-20251001";
    const resp = await trackAnthropicMessage(
      { salonId, feature: "staff_performance", model },
      () =>
        ai.messages.create({
          model,
          max_tokens: 300,
          messages: [{ role: "user", content: prompt }],
        }),
    );
    const raw = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    const cleaned = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as StaffInsight;
    if (!parsed.summary) return null;
    if (!Array.isArray(parsed.alerts)) parsed.alerts = [];
    return parsed;
  } catch (e) {
    console.error("[agentStaffPerformance] AI error", e);
    return null;
  }
}

// ── Email ─────────────────────────────────────────────────────────────────────

function buildStaffEmail(
  salonName: string,
  thisWeek: StaffStat[],
  absentStaff: string[],
  insight: StaffInsight,
): { subject: string; bodyText: string; bodyHtml: string } {
  const esc = (x: string) =>
    x.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));

  const staffRows = thisWeek
    .map((s) => {
      const flagColor = s.noShowRate > 20 ? "#dc2626" : "#374151";
      return `<tr>
        <td style="padding:6px 12px 6px 0;font-size:13px;color:#111;border-bottom:1px solid #f3f4f6">${esc(s.name)}</td>
        <td style="padding:6px 6px;font-size:13px;text-align:center;border-bottom:1px solid #f3f4f6">${s.completed}</td>
        <td style="padding:6px 6px;font-size:13px;text-align:center;color:${flagColor};font-weight:${s.noShowRate > 20 ? "700" : "400"};border-bottom:1px solid #f3f4f6">${s.noShowRate}%${s.noShowRate > 20 ? " ⚠️" : ""}</td>
        <td style="padding:6px 0 6px 6px;font-size:13px;text-align:right;font-weight:600;border-bottom:1px solid #f3f4f6">$${(s.revenueCents / 100).toFixed(0)}</td>
      </tr>`;
    })
    .join("");

  const alertsHtml =
    insight.alerts.length > 0
      ? `<div style="background:#fef2f2;border-radius:8px;padding:12px 14px;margin:16px 0">
          <p style="font-size:12px;font-weight:700;color:#991b1b;margin:0 0 6px">⚠️ Cần chú ý</p>
          ${insight.alerts.map((a) => `<p style="font-size:13px;color:#b91c1c;margin:0 0 4px">· ${esc(a)}</p>`).join("")}
        </div>`
      : "";

  const absentHtml =
    absentStaff.length > 0
      ? `<div style="background:#fff7ed;border-radius:8px;padding:10px 14px;margin-top:12px">
          <p style="font-size:12px;color:#92400e;margin:0">📵 Không có lịch tuần này (so với tuần trước): <strong>${absentStaff.map(esc).join(", ")}</strong></p>
        </div>`
      : "";

  const bodyHtml = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:540px;color:#1a1a1a;padding:8px">
  <p style="font-size:11px;color:#999;margin:0 0 12px;text-transform:uppercase;letter-spacing:.08em">Báo Cáo Nhân Viên Tuần · ${esc(salonName)}</p>

  <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 16px">${esc(insight.summary)}</p>

  ${alertsHtml}
  ${absentHtml}

  ${
    staffRows
      ? `<p style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin:16px 0 6px">Chi Tiết Nhân Viên</p>
    <table style="width:100%;border-collapse:collapse">
      <tr style="border-bottom:2px solid #e5e7eb">
        <th style="padding:4px 12px 4px 0;font-size:11px;color:#6b7280;text-align:left;font-weight:600">Nhân Viên</th>
        <th style="padding:4px 6px;font-size:11px;color:#6b7280;text-align:center;font-weight:600">Hoàn Thành</th>
        <th style="padding:4px 6px;font-size:11px;color:#6b7280;text-align:center;font-weight:600">No-show</th>
        <th style="padding:4px 0 4px 6px;font-size:11px;color:#6b7280;text-align:right;font-weight:600">Doanh Thu</th>
      </tr>
      ${staffRows}
    </table>`
      : ""
  }

  <p style="font-size:11px;color:#aaa;margin-top:20px">— Quản Lý AI · ${esc(salonName)}</p>
</div>`;

  const textLines = thisWeek
    .map(
      (s) =>
        `  ${s.name}: ${s.completed} lịch · $${(s.revenueCents / 100).toFixed(0)} · no-show ${s.noShowRate}%${s.noShowRate > 20 ? " ⚠️" : ""}`,
    )
    .join("\n");

  const bodyText = `${salonName} — Nhân Viên Tuần\n\n${insight.summary}\n\n${textLines}${absentStaff.length > 0 ? `\n\nKhông có lịch: ${absentStaff.join(", ")}` : ""}${insight.alerts.length > 0 ? `\n\nCảnh báo:\n${insight.alerts.map((a) => `· ${a}`).join("\n")}` : ""}`;

  const flagged = thisWeek.filter((s) => s.noShowRate > 20).length + absentStaff.length;

  return {
    subject: `${salonName} · Nhân Viên Tuần${flagged > 0 ? ` ⚠️ ${flagged} cần chú ý` : ""}`,
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
    .eq("agent" as never, "staff_performance")
    .gte("created_at" as never, since)
    .limit(1);
  return ((data ?? []) as unknown[]).length > 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runStaffPerformance(salonId: string): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons" as never)
      .select("name, feature_flags, ai_profile" as never)
      .eq("id" as never, salonId)
      .maybeSingle();

    const s = (salon as Row | null) ?? {};
    const flags = (s.feature_flags as Record<string, boolean> | null) ?? {};
    if (!flags.ai_staff_performance) return;
    if (await alreadyRanThisWeek(salonId)) return;

    const salonName = str(s.name) || "our salon";
    const sip = (s.ai_profile as Partial<SalonIntelligenceProfile> | null) ?? null;
    const lang: "vi" | "en" = sip?.language_primary === "vi" ? "vi" : "en";

    const [thisWeek, lastWeek] = await Promise.all([
      gatherStaffStats(salonId, 0),
      gatherStaffStats(salonId, 1),
    ]);

    if (thisWeek.length === 0 && lastWeek.length === 0) return;

    // Detect staff who worked last week but have zero bookings this week
    const thisWeekIds = new Set(thisWeek.map((s) => s.staffId));
    const absentStaff = lastWeek
      .filter((s) => !thisWeekIds.has(s.staffId) && s.completed + s.noShow >= 2)
      .map((s) => s.name);

    const insight = await analyzeStaff(
      salonId,
      salonName,
      lang,
      thisWeek,
      absentStaff,
    );
    if (!insight) return;

    const { subject, bodyText, bodyHtml } = buildStaffEmail(
      salonName,
      thisWeek,
      absentStaff,
      insight,
    );
    await sendOwnerAlert(salonId, { subject, bodyText, bodyHtml });

    const alertCount =
      thisWeek.filter((s) => s.noShowRate > 20).length + absentStaff.length;
    const topStaff = thisWeek[0]?.name ?? null;

    const svc = createServiceRoleClient();
    await svc.from("ai_actions_log" as never).insert({
      salon_id: salonId,
      agent: "staff_performance",
      action_type: "weekly_staff_summary",
      target_id: null,
      payload: {
        staffCount: thisWeek.length,
        alertCount,
        topStaff,
        flaggedStaff: [
          ...thisWeek.filter((s) => s.noShowRate > 20).map((s) => s.name),
          ...absentStaff,
        ],
        totalRevenueCents: thisWeek.reduce((s, r) => s + r.revenueCents, 0),
        summary: insight.summary,
      },
      undo_deadline: null,
    } as never);

    console.log(
      `[staff_performance] ${salonName}: ${thisWeek.length} staff, ${alertCount} flagged`,
    );
  } catch (e) {
    console.error("[runStaffPerformance]", e);
    throw e;
  }
}
