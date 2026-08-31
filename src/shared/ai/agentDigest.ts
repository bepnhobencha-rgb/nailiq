import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { createTextBackgroundAnthropicClient } from "@/shared/ai/anthropicProviderPolicy";
import {
  claimAiExecutionSlot,
  ruleFirstOptimizationEnabled,
} from "@/shared/ai/executionLimit";
import { trackAnthropicMessage } from "@/shared/ai/usageLedger";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonToday, salonDayRangeUtc } from "@/shared/lib/salonTime";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { emailExperienceTags } from "@/shared/lib/emailExperienceRegistry";
import { parseOwnerNotificationSettings } from "@/shared/dashboard/ownerNotificationSettings";
import { getOutcomeStats } from "@/shared/ai/agentOutcomeTracker";
import { loadUnclosedBookings } from "@/shared/dashboard/loadUnclosedBookings";
import {
  unclosedBookingHref,
  type UnclosedBookingsResult,
} from "@/shared/dashboard/unclosedBookingTypes";
import {
  approvalAllowsEmail,
  getPendingApprovals,
} from "@/shared/ai/approvalRequests";

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
  if (!_ai) _ai = createTextBackgroundAnthropicClient(key);
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
  pendingApprovalSummaries: string[],
  /** How many past appointments still have no final status. Fed to the model so
   *  Minh raises it in the narrative; the tappable list lives in the HTML. */
  unclosedCount: number,
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

    const p0 = a.actions[0]?.payload ?? {};
    const label: Record<string, string> = {
      winback: `Kéo Về: gửi ${count} tin giữ khách${names ? ` (${names})` : ""}`,
      rebook: `Nhịp Tim: nhắc ${count} khách tái ghé${names ? ` (${names})` : ""}`,
      vip_care: `VIP Care: chăm sóc ${count} khách đặc biệt${names ? ` (${names})` : ""}`,
      first_visit: `Lần đầu: chào đón / nhắc ${count} khách mới${names ? ` (${names})` : ""}`,
      watchdog: `Radar: ghi nhận ${count} cảnh báo vận hành`,
      revenue_report: (() => {
        const rev = Math.round(num(p0.revenueCents) / 100);
        const ticket = Math.round(num(p0.avgTicketCents) / 100);
        const chg = num(p0.changeVsLastWeekPct);
        return `Doanh Thu: tuần này $${rev} · ticket TB $${ticket} · ${chg >= 0 ? "+" : ""}${chg}% so tuần trước`;
      })(),
      staff_performance: (() => {
        const alerts = num(p0.alertCount);
        const staffCount = num(p0.staffCount);
        return `Nhân Viên: ${staffCount} người · ${alerts > 0 ? `⚠️ ${alerts} cần chú ý` : "hiệu suất ổn định"}`;
      })(),
      cancellation_radar: (() => {
        const rate = num(p0.cancellationRatePct);
        const total = num(p0.cancelCount);
        const spike = p0.spike === true;
        const worstDay = str(p0.worstDow);
        return `Huỷ Lịch: ${total} huỷ · tỷ lệ ${rate}%${spike ? " ⚠️ tăng bất thường" : ""}${worstDay ? ` · nhiều nhất: ${worstDay}` : ""}`;
      })(),
      social_content:
        `Social Content: đã soạn ${count} caption nháp và gửi cho chủ tiệm để tự duyệt/đăng; AI không đăng lên mạng xã hội`,
    };
    agentLines.push(label[a.agent] ?? `${a.agent}: ${count} hành động`);
  }

  const alertLines = alerts.map((al) => `[${al.severity.toUpperCase()}] ${al.summary}`);
  const approvalsSection = pendingApprovalSummaries.length > 0
    ? `\nVIỆC CHỜ MINH DUYỆT (${pendingApprovalSummaries.length}):\n${pendingApprovalSummaries.map((s) => `- ${s}`).join("\n")}\nXem chi tiết: /dashboard/{slug}/approvals`
    : "";

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

LỊCH HẸN CHƯA CHỐT SỔ:
${unclosedCount > 0 ? `${unclosedCount} lịch hẹn đã qua nhưng nhân viên chưa đánh dấu hoàn thành hoặc không đến. Doanh thu và tỉ lệ no-show đang bị thiếu. Nhắc chủ tiệm xử lý, danh sách bấm được nằm cuối email.` : "Không có — mọi lịch đã chốt sổ."}

CẢNH BÁO (nếu có):
${alertLines.length > 0 ? alertLines.join("\n") : "Không có cảnh báo."}${approvalsSection}`;
}

async function draftDigest(
  context: string,
  salonId: string,
  salonName: string,
  lang: "en" | "vi",
): Promise<string | null> {
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
- Booking statuses, revenue, cancellations, and no-shows are observations from the salon database. Never claim that you created, completed, cancelled, or marked those records unless VIỆC AI ĐÃ LÀM HÔM NAY explicitly says so
- "sent_social_draft" means a caption DRAFT was sent privately to the salon owner for review/copying. Never say it was posted, published, or uploaded to social media
- If mentioning a no-show, say "hệ thống ghi nhận" or "nhân viên đã đánh dấu". Never say "tôi đã ghi nhận/đánh dấu" unless an explicit AI action says so
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
    const model = "claude-sonnet-4-6";
    const resp = await trackAnthropicMessage(
      { salonId, feature: "digest", model },
      () => ai.messages.create({
      model,
      // Was 400 — too tight for "3-4 short paragraphs" of Vietnamese prose on
      // an eventful day (many agent actions/alerts), which silently sent a
      // mid-sentence cut-off email once observed in prod (Hi-Lite Studio,
      // 2026-07-04: body ended "...tiệm đã có 1 lị"). Raised with headroom;
      // the stop_reason guard below is the real backstop against this class
      // of bug recurring for any reason.
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
      }),
    );
    // A response cut off mid-generation is worse than no digest at all — skip
    // sending (caller treats null as "don't send today") rather than mail a
    // broken half-sentence to the owner.
    if (resp.stop_reason === "max_tokens") return null;
    const text = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "";
    return text.length > 50 ? text : null;
  } catch {
    return null;
  }
}

export function shouldUseAiDigest(input: {
  agentActionCount: number;
  alertCount: number;
  pendingApprovalCount: number;
  unclosedCount: number;
}): boolean {
  return (
    input.agentActionCount > 0 ||
    input.alertCount > 0 ||
    input.pendingApprovalCount > 0 ||
    input.unclosedCount > 0
  );
}

export type DigestGroundingFacts = {
  hasSocialDraft: boolean;
  noShowCount: number;
};

/**
 * Deterministic truth gate for LLM-written owner emails. Prompt instructions
 * improve wording, while this guard prevents the two observed false claims
 * from reaching an owner even if a model ignores those instructions.
 */
export function isDigestGrounded(
  body: string,
  facts: DigestGroundingFacts,
): boolean {
  const normalized = body.replace(/\s+/g, " ");

  if (facts.hasSocialDraft) {
    // Remove explicit denials before looking for a positive publication claim.
    const publicationClaimsOnly = normalized.replace(
      /(?:chưa|không)\s+(?:đăng|xuất bản).{0,50}(?:bài|nội dung|mạng xã hội|facebook|instagram)/giu,
      "",
    );
    const claimsSocialPublication =
      /(?:đã\s+)?(?:đăng|xuất bản).{0,50}(?:bài|nội dung|mạng xã hội|facebook|instagram)|(?:published|posted).{0,50}(?:social|facebook|instagram|content|post)/iu;
    if (claimsSocialPublication.test(publicationClaimsOnly)) return false;
  }

  if (facts.noShowCount > 0) {
    const selfAttributedNoShow =
      /(?:\btôi\b|\bi\b).{0,80}(?:ghi nhận|đánh dấu|recorded|marked).{0,50}(?:no[- ]?show|không đến)|(?:no[- ]?show|không đến).{0,80}(?:\btôi\b|\bi\b).{0,50}(?:ghi nhận|đánh dấu|recorded|marked)/iu;
    if (selfAttributedNoShow.test(normalized)) return false;
  }

  return true;
}

export function deterministicDigestBody(
  salonName: string,
  stats: BookingStats,
  unclosedCount: number,
  facts: DigestGroundingFacts,
): string {
  const revenue = (stats.revenueCents / 100).toFixed(0);
  const noShow = stats.noShow > 0
    ? ` Hệ thống ghi nhận ${stats.noShow} khách không đến; trạng thái này do nhân viên hoặc dữ liệu vận hành xác nhận.`
    : "";
  const social = facts.hasSocialDraft
    ? " Tôi đã soạn caption nháp và gửi riêng cho chủ tiệm để duyệt hoặc tự đăng; NailIQ chưa đăng nội dung lên mạng xã hội."
    : "";
  const closeout = unclosedCount > 0
    ? ` Còn ${unclosedCount} lịch hẹn cần chốt sổ.`
    : "";
  return `${salonName}: Hôm nay đã hoàn thành ${stats.completed}/${stats.total} lịch hẹn, doanh thu ghi nhận $${revenue}.${noShow}${social} Ngày mai hiện có ${stats.tomorrowCount} lịch.${closeout}`;
}

// ─── Email send (bypasses sendOwnerAlert suppression) ─────────────────────────

export type PendingApprovalDigestItem = {
  id: string;
  summary: string;
  approve_token: string;
  decline_token: string;
};

export type DigestDeliveryResult =
  | {
      status: "sent";
      providerMessageId: string | null;
      recipientCount: number;
    }
  | {
      status: "skipped";
      reason: "notifications_disabled";
    }
  | {
      status: "failed";
      reason:
        | "settings_unavailable"
        | "provider_unavailable"
        | "no_recipients"
        | "send_failed";
    };

export async function sendDigestEmail(
  salonId: string,
  salonName: string,
  body: string,
  todayYmd: string,
  pendingApprovals?: PendingApprovalDigestItem[],
  /** Needed to build Front Desk deep links; the salon row is loaded in
   *  runDigest, so the slug is threaded down rather than re-queried. */
  slug?: string | null,
  unclosed?: UnclosedBookingsResult,
): Promise<DigestDeliveryResult> {
  const db = createServiceRoleClient();

  const { data: salonRow, error: settingsError } = await db
    .from("salons" as never)
    .select("owner_notification_settings")
    .eq("id", salonId)
    .maybeSingle();

  if (settingsError || !salonRow) {
    return { status: "failed", reason: "settings_unavailable" };
  }

  const rawSettings = (salonRow as { owner_notification_settings?: Record<string, unknown> } | null)
    ?.owner_notification_settings ?? {};
  const settings = parseOwnerNotificationSettings(rawSettings);
  if (!settings.enabled) {
    return { status: "skipped", reason: "notifications_disabled" };
  }

  const resend = getResendClient();
  if (!resend) {
    return { status: "failed", reason: "provider_unavailable" };
  }

  // digest_emails override: if set, send only to those addresses.
  // Falls back to all owner/admin members + customEmails when not configured.
  const digestEmailsOverride = Array.isArray(rawSettings.digest_emails)
    ? (rawSettings.digest_emails as string[]).filter(Boolean)
    : null;

  let recipients: string[];
  if (digestEmailsOverride && digestEmailsOverride.length > 0) {
    recipients = [...new Set(digestEmailsOverride.map((e) => e.toLowerCase()))];
  } else {
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
    recipients = [...new Set(emails.map((e) => e.toLowerCase()))];
  }
  if (recipients.length === 0) {
    return { status: "failed", reason: "no_recipients" };
  }

  const esc = (s: string) =>
    s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] ?? c));

  const paragraphs = body
    .split("\n\n")
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.75">${esc(p.replace(/\n/g, " "))}</p>`)
    .join("");

  // Append clickable approve/decline cards for any pending normal-urgency approvals
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca";
  const pendingHtml = (pendingApprovals ?? []).length > 0
    ? `<hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
<p style="font-size:13px;font-weight:700;color:#374151;margin:0 0 12px">
  ${(pendingApprovals ?? []).length} việc chờ Minh duyệt:
</p>
${(pendingApprovals ?? []).map((r) => `
<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;margin:0 0 10px">
  <p style="margin:0 0 10px;font-size:14px;color:#111">${esc(r.summary.slice(0, 120))}${r.summary.length > 120 ? "…" : ""}</p>
  <a href="${appUrl}/api/ai/approve?token=${r.approve_token}" style="background:#16a34a;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;display:inline-block;margin:0 6px 0 0;font-size:13px;font-weight:600">✓ Đồng ý</a>
  <a href="${appUrl}/api/ai/approve?token=${r.decline_token}" style="background:#dc2626;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;display:inline-block;font-size:13px;font-weight:600">✗ Từ chối</a>
</div>`).join("")}`
    : "";

  // Appointments the desk never closed out. Deterministic list rather than
  // prose: the body above is LLM-written and would paraphrase these away, and
  // the owner needs the exact rows to tap. Unlike the approval buttons these
  // links land in the dashboard, so they require a logged-in session.
  const unclosedHtml = (unclosed?.count ?? 0) > 0 && slug
    ? `<hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
<p style="font-size:13px;font-weight:700;color:#374151;margin:0 0 4px">
  ${unclosed!.count} lịch hẹn chưa chốt sổ:
</p>
<p style="font-size:12px;color:#6b7280;margin:0 0 12px">
  Đang thiếu trong doanh thu và tỉ lệ khách không đến. Bấm để mở đúng lịch hẹn.
</p>
${unclosed!.items.map((b) => `
<a href="${appUrl}${unclosedBookingHref(slug, b)}" style="display:block;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;margin:0 0 8px;text-decoration:none;color:#111">
  <span style="font-size:14px;font-weight:600">${esc(b.clientName)}</span>
  <span style="font-size:12px;color:#6b7280;float:right">${esc(b.dateYmd)}</span>
</a>`).join("")}${
  unclosed!.count > unclosed!.items.length
    ? `<p style="font-size:12px;color:#6b7280;margin:8px 0 0">… và ${unclosed!.count - unclosed!.items.length} lịch nữa trong Bảng điều khiển.</p>`
    : ""
}`
    : "";

  const html = `<div style="max-width:540px;margin:0 auto;font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;padding:8px">
  <p style="font-size:11px;color:#999;margin:0 0 20px;text-transform:uppercase;letter-spacing:.08em">${salonName} · ${todayYmd}</p>
  <div style="font-size:15px">${paragraphs}</div>
  ${pendingHtml}
  ${unclosedHtml}
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
  <p style="font-size:12px;color:#aaa;margin:0">— Quản Lý AI · ${salonName}</p>
</div>`;

  const { data, error } = await resend.emails.send(
    {
      from: getResendFrom(),
      to: recipients,
      subject: `${salonName} · Tổng kết ${todayYmd}`,
      html,
      tags: emailExperienceTags("ai_digest"),
      text:
        body +
        ((unclosed?.count ?? 0) > 0
          ? `\n\n${unclosed!.count} lịch hẹn chưa chốt sổ — xem trong Bảng điều khiển.`
          : "") +
        `\n\n— Quản Lý AI · ${salonName}`,
    },
    {
      // A worker retry after the provider accepted the email but before the
      // database acknowledgement must not send a second daily digest.
      idempotencyKey: `nailiq-digest-${salonId}-${todayYmd}`,
    },
  );

  if (error) {
    console.error("[sendDigestEmail] resend", error);
    return { status: "failed", reason: "send_failed" };
  }

  return {
    status: "sent",
    providerMessageId: data?.id ?? null,
    recipientCount: recipients.length,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runDigest(salonId: string): Promise<void> {
  try {
    const db = createServiceRoleClient();

    const { data: salonRow } = await db
      .from("salons" as never)
      .select("name, slug, feature_flags, timezone, ai_manager_instructions")
      .eq("id", salonId)
      .maybeSingle();

    const s = salonRow as { name?: string; slug?: string; feature_flags?: Record<string, unknown>; timezone?: string; ai_manager_instructions?: string | null } | null;
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
    const [
      stats,
      agentActions,
      alerts,
      outcomeStats,
      pendingApprovals,
      unclosed,
    ] = await Promise.all([
      getBookingStats(salonId, tz),
      getTodayAgentActions(salonId, tz),
      getTodayWatchdogAlerts(salonId, tz),
      getOutcomeStats(salonId),
      getPendingApprovals(salonId),
      // Same helper the dashboard card uses, so the two never disagree.
      loadUnclosedBookings(salonId, tz, { limit: 8 }).catch(() => ({
        count: 0,
        items: [],
      })),
    ]);

    const instructions = s.ai_manager_instructions ?? null;
    const emailablePendingApprovals = pendingApprovals.filter(
      approvalAllowsEmail,
    );
    const outcomeLines = outcomeStats.map(
      (o) => `${o.label}: ${o.sent} gửi → ${o.converted} quay lại (${o.pct}%)`,
    );
    // Normal-urgency pending approvals surface in digest as a summary section
    const pendingApprovalSummaries = emailablePendingApprovals
      .filter((r) => r.urgency === "normal")
      .map((r) => r.summary.slice(0, 100) + (r.summary.length > 100 ? "…" : ""));

    const context = buildContext(salonName, stats, agentActions, alerts, todayYmd, outcomeLines, instructions, pendingApprovalSummaries, unclosed.count);
    const groundingFacts: DigestGroundingFacts = {
      hasSocialDraft: agentActions.some(
        (summary) =>
          summary.agent === "social_content" &&
          summary.actions.some(
            (action) => action.action_type === "sent_social_draft",
          ),
      ),
      noShowCount: stats.noShow,
    };
    let body: string | null;
    if (ruleFirstOptimizationEnabled(s.feature_flags)) {
      const material = shouldUseAiDigest({
        agentActionCount: agentActions.reduce((sum, item) => sum + item.actions.length, 0),
        alertCount: alerts.length,
        pendingApprovalCount: emailablePendingApprovals.length,
        unclosedCount: unclosed.count,
      });
      const claimed = material
        ? await claimAiExecutionSlot({
            salonId,
            feature: "digest",
            dedupeKey: todayYmd,
            windowSeconds: 86400,
            maxCalls: 1,
          })
        : false;
      body = claimed
        ? (await draftDigest(context, salonId, salonName, "vi")) ??
          deterministicDigestBody(
            salonName,
            stats,
            unclosed.count,
            groundingFacts,
          )
        : deterministicDigestBody(
            salonName,
            stats,
            unclosed.count,
            groundingFacts,
          );
    } else {
      body = await draftDigest(context, salonId, salonName, "vi");
    }
    if (!body) return;
    if (!isDigestGrounded(body, groundingFacts)) {
      body = deterministicDigestBody(
        salonName,
        stats,
        unclosed.count,
        groundingFacts,
      );
    }

    // Pass normal-urgency approvals so the digest email renders one-tap buttons
    const digestApprovals = emailablePendingApprovals
      .filter((r) => r.urgency === "normal")
      .map((r) => ({
        id: r.id,
        summary: r.summary,
        approve_token: r.approve_token,
        decline_token: r.decline_token,
      }));

    const delivery = await sendDigestEmail(
      salonId,
      salonName,
      body,
      todayYmd,
      digestApprovals,
      s.slug ?? null,
      unclosed,
    );

    if (delivery.status === "skipped") return;
    if (delivery.status === "failed") {
      throw new Error(`digest_delivery_${delivery.reason}`);
    }

    const { error: deliveryRecordError } = await db.rpc(
      "record_ai_digest_delivery" as never,
      {
        p_salon_id: salonId,
        p_digest_date: todayYmd,
        p_provider_message_id: delivery.providerMessageId,
        p_sent_at: new Date().toISOString(),
        p_approval_ids: digestApprovals.map((approval) => approval.id),
        p_agents_active: agentActions.map((action) => action.agent),
        p_recipient_count: delivery.recipientCount,
      } as never,
    );

    if (deliveryRecordError) {
      throw new Error("digest_delivery_record_failed");
    }
  } catch (e) {
    console.error("[runDigest]", e);
    throw e;
  }
}
