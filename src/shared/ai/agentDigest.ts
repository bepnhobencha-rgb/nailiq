import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonToday, salonDayRangeUtc } from "@/shared/lib/salonTime";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { parseOwnerNotificationSettings } from "@/shared/dashboard/ownerNotificationSettings";
import { getOutcomeStats } from "@/shared/ai/agentOutcomeTracker";

/**
 * Unified Daily Digest — ONE email per day in the Manager's voice.
 * Replaces all individual agent owner-alerts when ai_unified_digest is ON.
 *
 * Runs at 21:00 salon time (after close). Reads ai_actions_log + watchdog_alerts
 * + booking stats → Sonnet writes a warm, cohesive narrative → one Resend call.
 */

const str = (v: unknown) => (v == null ? "" : String(v));
const num = (v: unknown) => (v == null ? 0 : Number(v));

let _ai: Anthropic | null = null;
function getAI(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!_ai) _ai = new Anthropic({ apiKey: key });
  return _ai;
}

// ─── Data gathering ───────────────────────────────────────────────────────────

type BookingStats = {
  total: number;
  completed: number;
  noShow: number;
  cancelled: number;
  revenueCents: number;
  newClients: number;
  tomorrowCount: number;
};

async function getBookingStats(salonId: string, tz: string): Promise<BookingStats> {
  const db = createServiceRoleClient();
  const todayYmd = salonToday(tz);
  const { startUtc, endUtc } = salonDayRangeUtc(todayYmd, tz);
  const tomorrowEnd = new Date(endUtc);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

  const [today, tomorrow] = await Promise.all([
    db.from("bookings").select("status, price_cents, created_at, client_profile_id")
      .eq("salon_id", salonId)
      .gte("start_time_utc", startUtc)
      .lt("start_time_utc", endUtc)
      .not("status", "eq", "cancelled_before_window"),
    db.from("bookings").select("id", { count: "exact", head: true })
      .eq("salon_id", salonId)
      .gte("start_time_utc", endUtc)
      .lt("start_time_utc", tomorrowEnd.toISOString())
      .not("status", "in", '("cancelled","cancelled_before_window","no_show")'),
  ]);

  const rows = (today.data ?? []) as { status: string; price_cents: number | null; created_at: string; client_profile_id: string | null }[];
  const todayStart = new Date(startUtc).getTime();

  return {
    total: rows.length,
    completed: rows.filter((r) => r.status === "completed").length,
    noShow: rows.filter((r) => r.status === "no_show").length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
    revenueCents: rows.filter((r) => r.status === "completed").reduce((s, r) => s + num(r.price_cents), 0),
    newClients: rows.filter((r) => !r.client_profile_id && new Date(r.created_at).getTime() >= todayStart).length,
    tomorrowCount: tomorrow.count ?? 0,
  };
}

type AgentSummary = {
  agent: string;
  actions: { action_type: string; payload: Record<string, unknown> }[];
};

async function getTodayAgentActions(salonId: string, tz: string): Promise<AgentSummary[]> {
  const db = createServiceRoleClient();
  const todayYmd = salonToday(tz);
  const { startUtc, endUtc } = salonDayRangeUtc(todayYmd, tz);

  const { data } = await db
    .from("ai_actions_log" as never)
    .select("agent, action_type, payload")
    .eq("salon_id", salonId)
    .gte("created_at", startUtc)
    .lt("created_at", endUtc)
    .not("action_type", "in", '("skipped_no_channel","suggestion_pending")');

  const rows = (data ?? []) as { agent: string; action_type: string; payload: unknown }[];
  const map = new Map<string, AgentSummary>();

  for (const r of rows) {
    const agent = str(r.agent) || "unknown";
    if (!map.has(agent)) map.set(agent, { agent, actions: [] });
    map.get(agent)!.actions.push({
      action_type: str(r.action_type),
      payload: (r.payload ?? {}) as Record<string, unknown>,
    });
  }
  return Array.from(map.values());
}

type WatchdogAlert = { kind: string; summary: string; severity: string };

async function getTodayWatchdogAlerts(salonId: string, tz: string): Promise<WatchdogAlert[]> {
  const db = createServiceRoleClient();
  const todayYmd = salonToday(tz);
  const { startUtc, endUtc } = salonDayRangeUtc(todayYmd, tz);

  const { data } = await db
    .from("watchdog_alerts" as never)
    .select("kind, summary, severity")
    .eq("salon_id", salonId)
    .gte("created_at", startUtc)
    .lt("created_at", endUtc)
    .not("severity", "eq", "info");

  return ((data ?? []) as WatchdogAlert[]);
}

// ─── AI narrative ─────────────────────────────────────────────────────────────

function buildContext(
  salonName: string,
  stats: BookingStats,
  agentActions: AgentSummary[],
  alerts: WatchdogAlert[],
  todayYmd: string,
  outcomeLines: string[],
  instructions: string | null,
): string {
  const revenue = (stats.revenueCents / 100).toFixed(0);

  // Describe what each agent did
  const agentLines: string[] = [];
  for (const a of agentActions) {
    const count = a.actions.length;
    const names = a.actions
      .map((x) => str(x.payload?.name))
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");

    const label: Record<string, string> = {
      winback: `Kéo Về: gửi ${count} tin giữ khách${names ? ` (${names})` : ""}`,
      rebook: `Nhịp Tim: nhắc ${count} khách tái ghé${names ? ` (${names})` : ""}`,
      vip_care: `VIP Care: chăm sóc ${count} khách đặc biệt${names ? ` (${names})` : ""}`,
      first_visit: `Lần đầu: chào đón / nhắc ${count} khách mới${names ? ` (${names})` : ""}`,
      watchdog: `Radar: ghi nhận ${count} cảnh báo vận hành`,
    };
    agentLines.push(label[a.agent] ?? `${a.agent}: ${count} hành động`);
  }

  const alertLines = alerts.map((al) => `[${al.severity.toUpperCase()}] ${al.summary}`);

  return `Ngày: ${todayYmd}
Tiệm: ${salonName}

THỐNG KÊ HÔM NAY:
- Tổng lịch: ${stats.total} | Hoàn thành: ${stats.completed} | No-show: ${stats.noShow} | Huỷ: ${stats.cancelled}
- Doanh thu: $${revenue} | Khách mới: ${stats.newClients}
- Ngày mai đã có: ${stats.tomorrowCount} lịch

VIỆC AI ĐÃ LÀM HÔM NAY:
${agentLines.length > 0 ? agentLines.join("\n") : "Không có hành động nào hôm nay."}

HIỆU QUẢ 30 NGÀY QUA (% khách quay lại sau khi Minh liên hệ):
${outcomeLines.length > 0 ? outcomeLines.join("\n") : "Chưa đủ dữ liệu (cần ít nhất 7 ngày sau khi gửi)."}

CHỈ ĐẠO TỪ CHỦ TIỆM:
${instructions?.trim() || "Không có chỉ đạo đặc biệt."}

CẢNH BÁO (nếu có):
${alertLines.length > 0 ? alertLines.join("\n") : "Không có cảnh báo."}`;
}

async function draftDigest(context: string, salonName: string, lang: "en" | "vi"): Promise<string | null> {
  const ai = getAI();
  const langLabel = lang === "vi" ? "tiếng Việt" : "English";

  const prompt = `You are the AI Manager of ${salonName}. Write the daily digest email to the salon owner in ${langLabel}.

Context (internal data — do not expose raw numbers mechanically):
${context}

Rules:
- Write in first person as the Manager ("Tôi đã...", "Hôm nay tiệm...")
- Warm, professional, concise — like a trusted manager giving end-of-day briefing
- 3-4 short paragraphs max
- Lead with the day's performance in 1 sentence
- Then what you (the AI Manager) DID today — be specific about names/services where available
- Then any alerts (only if severity is warning/critical — skip info)
- Close with tomorrow's outlook in 1 sentence
- NO bullet lists — flowing prose only
- NO subject line — just the body
- NO sign-off line — that's added automatically
- Return ONLY the email body text, nothing else`;

  if (!ai) {
    // Fallback plain summary
    return context;
  }

  try {
    const resp = await ai.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    return text.length > 50 ? text : null;
  } catch {
    return null;
  }
}

// ─── Email send (bypasses sendOwnerAlert suppression) ─────────────────────────

async function sendDigestEmail(
  salonId: string,
  salonName: string,
  body: string,
  todayYmd: string,
): Promise<void> {
  const db = createServiceRoleClient();
  const resend = getResendClient();
  if (!resend) return;

  const { data: salonRow } = await db
    .from("salons" as never)
    .select("owner_notification_settings")
    .eq("id", salonId)
    .maybeSingle();

  const settings = parseOwnerNotificationSettings(
    (salonRow as { owner_notification_settings?: unknown } | null)?.owner_notification_settings,
  );
  if (!settings.enabled) return;

  // Resolve owner/admin emails
  const { data: members } = await db
    .from("salon_members")
    .select("user_id, role")
    .eq("salon_id", salonId)
    .in("role", ["owner", "admin"]);

  const userIds = [...new Set(
    ((members ?? []) as { user_id: string }[]).map((m) => m.user_id).filter(Boolean),
  )];

  const emails = (
    await Promise.all(
      userIds.map(async (uid) => {
        const { data, error } = await db.auth.admin.getUserById(uid);
        return error ? null : (data.user?.email ?? null);
      }),
    )
  ).filter((e): e is string => !!e);

  for (const e of settings.customEmails) emails.push(e);
  const recipients = [...new Set(emails.map((e) => e.toLowerCase()))];
  if (recipients.length === 0) return;

  const esc = (s: string) =>
    s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] ?? c));

  const paragraphs = body
    .split("\n\n")
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.75">${esc(p.replace(/\n/g, " "))}</p>`)
    .join("");

  const html = `<div style="max-width:540px;margin:0 auto;font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;padding:8px">
  <p style="font-size:11px;color:#999;margin:0 0 20px;text-transform:uppercase;letter-spacing:.08em">${salonName} · ${todayYmd}</p>
  <div style="font-size:15px">${paragraphs}</div>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
  <p style="font-size:12px;color:#aaa;margin:0">— Quản Lý AI · ${salonName}</p>
</div>`;

  await resend.emails.send({
    from: getResendFrom(),
    to: recipients,
    subject: `${salonName} · Tổng kết ${todayYmd}`,
    html,
    text: body + `\n\n— Quản Lý AI · ${salonName}`,
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runDigest(salonId: string): Promise<void> {
  try {
    const db = createServiceRoleClient();

    const { data: salonRow } = await db
      .from("salons" as never)
      .select("name, feature_flags, timezone, ai_manager_instructions")
      .eq("id", salonId)
      .maybeSingle();

    const s = salonRow as { name?: string; feature_flags?: Record<string, unknown>; timezone?: string; ai_manager_instructions?: string | null } | null;
    if (!s) return;
    if (s.feature_flags?.ai_unified_digest !== true) return;

    const salonName = s.name ?? "our salon";
    const tz = s.timezone ?? "America/Los_Angeles";
    const todayYmd = salonToday(tz);

    // Dedupe: only one digest per day per salon
    const { startUtc, endUtc } = salonDayRangeUtc(todayYmd, tz);
    const { data: existing } = await db
      .from("ai_actions_log" as never)
      .select("id")
      .eq("salon_id", salonId)
      .eq("action_type", "digest_sent")
      .gte("created_at", startUtc)
      .lt("created_at", endUtc)
      .limit(1)
      .maybeSingle();

    if (existing) return; // already sent today

    // Gather data in parallel
    const [stats, agentActions, alerts, outcomeStats] = await Promise.all([
      getBookingStats(salonId, tz),
      getTodayAgentActions(salonId, tz),
      getTodayWatchdogAlerts(salonId, tz),
      getOutcomeStats(salonId),
    ]);

    const instructions = s.ai_manager_instructions ?? null;
    const outcomeLines = outcomeStats.map(
      (o) => `${o.label}: ${o.sent} gửi → ${o.converted} quay lại (${o.pct}%)`,
    );

    const context = buildContext(salonName, stats, agentActions, alerts, todayYmd, outcomeLines, instructions);
    const body = await draftDigest(context, salonName, "vi");
    if (!body) return;

    await sendDigestEmail(salonId, salonName, body, todayYmd);

    // Log so we don't send twice
    await db.from("ai_actions_log" as never).insert({
      salon_id: salonId,
      agent: "digest",
      action_type: "digest_sent",
      target_id: null,
      payload: { today: todayYmd, agents_active: agentActions.map((a) => a.agent) },
      undo_deadline: null,
    } as never);
  } catch (e) {
    console.error("[runDigest]", e);
  }
}
