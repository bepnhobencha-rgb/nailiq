"use server";

import { formatTranscript } from "@/shared/dashboard/formatTranscript";
import { customerMessageActivityItem } from "@/shared/dashboard/customerMessageActivity";
import { aiAgentPermissionActivityItem } from "@/shared/dashboard/aiAgentPermissionActivity";
import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import {
  voiceSessionDisplayStatus,
  voiceSessionStatusLabel,
} from "@/shared/dashboard/voiceSessionActivity";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { voiceSessionDurationSuffix } from "@/shared/voiceai/sessionDuration";

/**
 * Unified "Activity / Communications log" for the salon owner — one timeline
 * that merges what the system DID and SENT, so staff can review it later:
 *   - booking_events   → who did what (created/edited/cancelled/status), with a
 *                        deep-link to the real appointment.
 *   - booking_notifications → SMS + email (sent/delivered/failed, inbound replies).
 *   - voice_ai_sessions → AI phone calls (+ transcript, duration).
 *
 * Owner-gated (booking_events RLS is owner/senior; we read via service-role
 * after gating here). Read-only.
 */

export type ActivityKind = "event" | "sms" | "email" | "call" | "system" | "login" | "ai" | "watchdog" | "winback";

const PROTECTION_LABEL: Record<string, string> = {
  none: "không đòi gì",
  card: "yêu cầu lưu thẻ",
  deposit: "yêu cầu đặt cọc",
};

/** Short, human device label from a user-agent string (for the login log). */
function deviceLabel(ua: string): string {
  if (!ua) return "Thiết bị lạ";
  const os = /iphone/i.test(ua)
    ? "iPhone"
    : /ipad/i.test(ua)
      ? "iPad"
      : /android/i.test(ua)
        ? "Android"
        : /windows/i.test(ua)
          ? "Windows"
          : /mac os|macintosh/i.test(ua)
            ? "Mac"
            : /linux/i.test(ua)
              ? "Linux"
              : "Máy khác";
  const browser = /edg\//i.test(ua)
    ? "Edge"
    : /chrome|crios/i.test(ua)
      ? "Chrome"
      : /firefox|fxios/i.test(ua)
        ? "Firefox"
        : /safari/i.test(ua)
          ? "Safari"
          : "";
  return browser ? `${os} · ${browser}` : os;
}

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  when: string; // ISO
  /** Headline, e.g. "Lễ tân đã tạo lịch cho An" / "SMS nhắc 24h". */
  title: string;
  /** Secondary line: phone / status / preview. */
  subtitle: string | null;
  /** Delivery status for SMS/email rows: sent | delivered | failed. */
  status: string | null;
  /** Actor role for event rows (owner/senior/nail_tech/system…). */
  actorRole: string | null;
  /** Raw booking event discriminator. Lets the Activity UI offer a dedicated
   *  cancelled-history view without inferring state from translated copy. */
  eventType?: string | null;
  /** Linked booking → deep-link target. */
  bookingId: string | null;
  /** Booking's salon-local date (YYYY-MM-DD) for the /center?date=&booking= link. */
  bookingDate: string | null;
  /** Full call transcript (call rows only). */
  transcript: string | null;
  /** ai_actions_log id — present when this item can be undone within its window. */
  undoActionId?: string | null;
};

export type LoadActivityFeedResult =
  | { ok: true; items: ActivityItem[] }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

const PER_SOURCE = 60;

const EVENT_TITLE: Record<string, string> = {
  booking_created: "đã tạo lịch hẹn cho {name}",
  booking_edited: "đã sửa lịch hẹn của {name}",
  booking_cancelled: "đã hủy lịch hẹn của {name}",
  booking_restored: "đã khôi phục lịch hẹn của {name}",
  booking_status_changed: "đã đổi trạng thái lịch của {name}",
  booking_price_set: "đã đặt giá cho lịch của {name}",
  walkin_added: "đã thêm khách vãng lai {name}",
  addon_added: "đã thêm dịch vụ kèm cho {name}",
  queue_joined: "{name} vào hàng chờ",
  queue_assigned: "đã xếp chỗ cho {name}",
  queue_left: "{name} rời hàng chờ",
};

const ROLE_LABEL: Record<string, string> = {
  owner: "Chủ tiệm",
  senior: "Quản lý",
  manager: "Quản lý",
  nail_tech: "Thợ",
  trainee: "Học việc",
  viewer: "Nhân viên",
  accounting: "Kế toán",
  public_guest: "Khách",
  demo_cookie: "Demo",
  system: "Hệ thống",
};

const NOTIF_TITLE: Record<string, string> = {
  booking_confirmation: "Xác nhận đặt lịch",
  reminder_24h: "Nhắc trước 24 giờ",
  reminder_3h: "Nhắc trước 3 giờ",
  review_request: "Mời đánh giá",
  waitlist_invite: "Mời từ danh sách chờ",
  inbound_confirm: "Khách nhắn xác nhận",
  inbound_cancel: "Khách nhắn hủy",
};

const str = (v: unknown): string => (v == null ? "" : String(v));

const TABLE_LABEL: Record<string, string> = {
  salons: "Cài đặt tiệm",
  staff: "Nhân viên",
  services: "Dịch vụ & giá",
  square_integrations: "Tích hợp Square",
};

/** Build a readable line from a system_audit row's changed_fields jsonb. */
function describeAudit(table: string, action: string, changed: Record<string, unknown>): { title: string; subtitle: string | null } {
  const label = TABLE_LABEL[table] ?? table;
  if (action === "INSERT" || changed._action === "created") {
    return { title: `Đã thêm ${label}`, subtitle: null };
  }
  if (action === "DELETE" || changed._action === "deleted") {
    return { title: `Đã xóa ${label}`, subtitle: null };
  }
  // UPDATE — list changed fields old→new (skip the _action marker).
  const parts: string[] = [];
  for (const [k, v] of Object.entries(changed)) {
    if (k === "_action") continue;
    const oldNew = v as { old?: unknown; new?: unknown };
    const o = oldNew?.old == null ? "—" : String(oldNew.old);
    const n = oldNew?.new == null ? "—" : String(oldNew.new);
    parts.push(`${k}: ${o.slice(0, 24)}→${n.slice(0, 24)}`);
    if (parts.length >= 4) break;
  }
  return { title: `Đổi ${label}`, subtitle: parts.join(" · ") || null };
}

function salonDate(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  // en-CA gives YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/**
 * Lightweight unread count for the activity bell — how many items across all
 * sources are newer than `sinceIso` (the owner's last-seen marker). Owner-gated.
 */
export async function getActivityUnreadCount(
  slug: string,
  sinceIso: string,
): Promise<{ ok: true; count: number } | { ok: false }> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved || !isOwnerOrAdmin(resolved.role)) return { ok: false };
  const since = Number.isFinite(Date.parse(sinceIso))
    ? new Date(Date.parse(sinceIso)).toISOString()
    : new Date(Date.now() - 86_400_000).toISOString();
  const salonId = resolved.salon.id;
  const db = createServiceRoleClient();

  const tables = [
    "booking_events",
    "booking_notifications",
    "voice_ai_sessions",
    "system_audit",
    "auth_events",
    "ai_policy_decisions",
    "watchdog_alerts",
    "winback_suggestions",
    "ai_actions_log",
  ];
  try {
    const results = await Promise.all(
      tables.map((t) =>
        db
          .from(t as never)
          .select("id", { count: "exact", head: true })
          .eq("salon_id", salonId)
          .gt("created_at", since),
      ),
    );
    const count = results.reduce((sum, r) => sum + (r.count ?? 0), 0);
    return { ok: true, count };
  } catch (e) {
    console.error("[getActivityUnreadCount]", e);
    return { ok: false };
  }
}

export async function loadActivityFeed(
  slug: string,
): Promise<LoadActivityFeedResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(resolved.role)) return { ok: false, error: "forbidden" };

  const salonId = resolved.salon.id;
  const db = createServiceRoleClient();

  try {
    const { data: salonRow } = await db
      .from("salons" as never)
      .select("timezone")
      .eq("id", salonId)
      .maybeSingle();
    const tz = (salonRow as { timezone?: string } | null)?.timezone || "America/Los_Angeles";

    const now = new Date().toISOString();
    const [
      eventsRes,
      notifsRes,
      callsRes,
      auditRes,
      agentPermissionAuditRes,
      authRes,
      aiRes,
      watchdogRes,
      winbackRes,
      aiActionsRes,
      customerMessagesRes,
    ] = await Promise.all([
      db
        .from("booking_events" as never)
        .select("id, booking_id, actor_role, event_type, payload, created_at, bookings ( client_name, start_time_utc )")
        .eq("salon_id", salonId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE),
      db
        .from("booking_notifications" as never)
        .select("id, booking_id, notification_type, channel, status, client_phone, body_preview, created_at, bookings ( start_time_utc )")
        .eq("salon_id", salonId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE),
      db
        .from("voice_ai_sessions" as never)
        .select("id, started_at, ended_at, status, duration_seconds, transcript, client_name, client_phone, created_at")
        .eq("salon_id", salonId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE),
      db
        .from("system_audit" as never)
        .select("id, table_name, action, changed_fields, created_at, actor_user_id")
        .eq("salon_id", salonId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE),
      db
        .from("ai_agent_permission_audit" as never)
        .select("id, actor_user_id, actor_role, actor_kind, flag_key, impact, enabled, previous_enabled, impact_acknowledged, created_at")
        .eq("salon_id", salonId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE),
      db
        .from("auth_events" as never)
        .select("id, event_type, actor_role, ip, user_agent, created_at")
        .eq("salon_id", salonId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE),
      db
        .from("ai_policy_decisions" as never)
        .select("id, mode, ai_protection, ai_fee_percent, ai_message, ai_reason, ai_confidence, rule_protection, actor_user_id, created_at, bookings ( client_name, start_time_utc )")
        .eq("salon_id", salonId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE),
      db
        .from("watchdog_alerts" as never)
        .select("id, kind, severity, title, body, created_at")
        .eq("salon_id", salonId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE),
      db
        .from("winback_suggestions" as never)
        .select("id, client_name, visit_count, channel, status, message, kind, created_at")
        .eq("salon_id", salonId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE),
      // ACT+UNDO: fetch ai_actions_log entries for winback/rebook that are still
      // within their undo window so we can surface the Undo button on matching items.
      db
        .from("ai_actions_log" as never)
        .select("id, agent, target_id, undo_deadline, undone_at, created_at")
        .eq("salon_id", salonId)
        .in("agent", ["winback", "rebook"])
        .gt("undo_deadline", now)
        .is("undone_at", null)
        .order("created_at", { ascending: false })
        .limit(50),
      db
        .from("ai_actions_log" as never)
        .select("id, payload, created_at")
        .eq("salon_id", salonId)
        .eq("action_type", "customer_message_escalation")
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE),
    ]);

    // Build lookup: winback_suggestion.id → ai_action.id (for undo button)
    const undoMap = new Map<string, string>();
    for (const r of (aiActionsRes.data ?? []) as Array<Record<string, unknown>>) {
      const targetId = str(r.target_id);
      const actionId = str(r.id);
      if (targetId && actionId) undoMap.set(targetId, actionId);
    }

    const items: ActivityItem[] = [];

    for (const r of (eventsRes.data ?? []) as Array<Record<string, unknown>>) {
      const booking = r.bookings as { client_name?: string | null; start_time_utc?: string | null } | null;
      const name = (booking?.client_name ?? "").toString().trim() || "khách";
      const role = str(r.actor_role) || "system";
      const tmpl = EVENT_TITLE[str(r.event_type)] ?? str(r.event_type);
      items.push({
        id: `ev-${str(r.id)}`,
        kind: "event",
        when: str(r.created_at),
        title: `${ROLE_LABEL[role] ?? role} ${tmpl.replace("{name}", name)}`,
        subtitle: null,
        status: null,
        actorRole: role,
        eventType: str(r.event_type) || null,
        bookingId: r.booking_id ? str(r.booking_id) : null,
        bookingDate: booking?.start_time_utc ? salonDate(str(booking.start_time_utc), tz) : null,
        transcript: null,
      });
    }

    for (const r of (notifsRes.data ?? []) as Array<Record<string, unknown>>) {
      const booking = r.bookings as { start_time_utc?: string | null } | null;
      const channel = str(r.channel) || "sms";
      const title = NOTIF_TITLE[str(r.notification_type)] ?? str(r.notification_type);
      items.push({
        id: `nt-${str(r.id)}`,
        kind: channel === "email" ? "email" : "sms",
        when: str(r.created_at),
        title,
        subtitle: str(r.body_preview) || str(r.client_phone) || null,
        status: str(r.status) || null,
        actorRole: null,
        bookingId: r.booking_id ? str(r.booking_id) : null,
        bookingDate: booking?.start_time_utc ? salonDate(str(booking.start_time_utc), tz) : null,
        transcript: null,
      });
    }

    const activityLoadedAt = Date.now();
    for (const r of (callsRes.data ?? []) as Array<Record<string, unknown>>) {
      const name = str(r.client_name).trim() || str(r.client_phone) || "Cuộc gọi";
      const durStr = voiceSessionDurationSuffix(r.duration_seconds);
      const displayStatus = voiceSessionDisplayStatus(
        r.status,
        r.started_at,
        r.ended_at,
        activityLoadedAt,
      );
      items.push({
        id: `cl-${str(r.id)}`,
        kind: "call",
        when: str(r.created_at) || str(r.started_at),
        title: `Cuộc gọi AI · ${name}`,
        subtitle: `${voiceSessionStatusLabel(displayStatus)}${durStr}`,
        status: displayStatus,
        actorRole: null,
        bookingId: null,
        bookingDate: null,
        transcript: formatTranscript(r.transcript),
      });
    }

    for (const r of (customerMessagesRes.data ?? []) as Array<Record<string, unknown>>) {
      items.push(customerMessageActivityItem(r));
    }

    // Resolve actor user ids → staff names so config changes read "Mai · Đổi …".
    // Includes AI-decision OVERRIDE actors so those rows can name who corrected
    // the agent.
    const auditRows = (auditRes.data ?? []) as Array<Record<string, unknown>>;
    const agentPermissionAuditRows = (
      agentPermissionAuditRes.data ?? []
    ) as Array<Record<string, unknown>>;
    const aiRows = (aiRes.data ?? []) as Array<Record<string, unknown>>;
    const auditUserIds = [
      ...new Set(
        [...auditRows, ...agentPermissionAuditRows, ...aiRows]
          .map((r) => str(r.actor_user_id))
          .filter(Boolean),
      ),
    ];
    const nameById = new Map<string, string>();
    if (auditUserIds.length > 0) {
      const { data: staffRows } = await db
        .from("staff" as never)
        .select("user_id, name")
        .eq("salon_id", salonId)
        .in("user_id", auditUserIds);
      for (const s of (staffRows ?? []) as Array<Record<string, unknown>>) {
        const u = str(s.user_id);
        const n = str(s.name).trim();
        if (u && n) nameById.set(u, n);
      }
    }

    const permissionTransitionKeys = new Set(
      agentPermissionAuditRows.map(
        (r) => `${str(r.created_at)}|${str(r.actor_user_id)}`,
      ),
    );
    for (const r of agentPermissionAuditRows) {
      items.push(
        aiAgentPermissionActivityItem(
          r,
          r.actor_user_id ? nameById.get(str(r.actor_user_id)) : null,
        ),
      );
    }

    for (const r of auditRows) {
      const changed = (r.changed_fields && typeof r.changed_fields === "object"
        ? (r.changed_fields as Record<string, unknown>)
        : {});
      // set_ai_agent_permission writes both the generic salons audit and the
      // purpose-built permission audit in one transaction. Prefer the explicit
      // permission item so the owner sees one truthful event, not two.
      if (
        str(r.table_name) === "salons" &&
        Object.prototype.hasOwnProperty.call(changed, "feature_flags") &&
        permissionTransitionKeys.has(
          `${str(r.created_at)}|${str(r.actor_user_id)}`,
        )
      ) {
        continue;
      }
      const base = describeAudit(str(r.table_name), str(r.action), changed);
      const actorName = r.actor_user_id ? nameById.get(str(r.actor_user_id)) : null;
      const { title, subtitle } = {
        title: actorName ? `${actorName} · ${base.title}` : base.title,
        subtitle: base.subtitle,
      };
      items.push({
        id: `sy-${str(r.id)}`,
        kind: "system",
        when: str(r.created_at),
        title,
        subtitle,
        status: null,
        actorRole: null,
        bookingId: null,
        bookingDate: null,
        transcript: null,
      });
    }

    for (const r of (authRes.data ?? []) as Array<Record<string, unknown>>) {
      const isLogin = str(r.event_type) === "login";
      const dev = deviceLabel(str(r.user_agent));
      const ip = str(r.ip);
      items.push({
        id: `au-${str(r.id)}`,
        kind: "login",
        when: str(r.created_at),
        title: `${isLogin ? "Đăng nhập" : "Đăng xuất"}${r.actor_role ? ` · ${ROLE_LABEL[str(r.actor_role)] ?? str(r.actor_role)}` : ""}`,
        subtitle: `${dev}${ip ? ` · IP ${ip}` : ""}`,
        status: null,
        actorRole: r.actor_role ? str(r.actor_role) : null,
        bookingId: null,
        bookingDate: null,
        transcript: null,
      });
    }

    for (const r of aiRows) {
      const booking = r.bookings as { client_name?: string | null } | null;
      const name = (booking?.client_name ?? "").toString().trim() || "khách";
      const aiP = PROTECTION_LABEL[str(r.ai_protection)] ?? str(r.ai_protection);
      const ruleP = PROTECTION_LABEL[str(r.rule_protection)] ?? str(r.rule_protection);
      const mode = str(r.mode);
      const shadow = mode === "shadow";
      const override = mode === "override";
      const actorName = r.actor_user_id ? nameById.get(str(r.actor_user_id)) : null;
      const pct = r.ai_fee_percent != null ? ` ${str(r.ai_fee_percent)}%` : "";
      const aiMsg = str(r.ai_message).trim();
      // Title: shadow = "đề nghị (thử nghiệm)", live = "quyết định", override =
      // "{nhân viên} ghi đè AI → ...".
      const title = override
        ? `✍️ ${actorName ? `${actorName} ` : ""}ghi đè AI → ${aiP} — ${name}`
        : `🤖 AI ${shadow ? "(thử nghiệm) đề nghị" : "quyết định"} ${aiP} — ${name}`;
      // Full detail (shown when the row is expanded).
      const detail = override
        ? [
            `Người sửa: ${actorName || "nhân viên"}`,
            `Đổi thành: ${aiP}  ·  Trước đó: ${ruleP || "—"}`,
            ``,
            `${str(r.ai_reason) || "—"}`,
          ].join("\n")
        : [
            `Quyết định: ${aiP}${pct}  ·  Độ tự tin: ${str(r.ai_confidence) || "—"}`,
            `Công thức cũ: ${ruleP || "—"}${ruleP && ruleP !== aiP ? "   ⚠️ AI khác công thức cũ" : ""}`,
            ``,
            `Lý do: ${str(r.ai_reason) || "—"}`,
            ...(aiMsg ? ["", "Lời nhắn AI soạn cho khách:", aiMsg] : []),
          ].join("\n");
      items.push({
        id: `ai-${str(r.id)}`,
        kind: "ai",
        when: str(r.created_at),
        title,
        subtitle: override
          ? str(r.ai_reason)
          : `${str(r.ai_reason)}${ruleP ? ` · Rule cũ: ${ruleP}` : ""}${r.ai_confidence ? ` · tự tin: ${str(r.ai_confidence)}` : ""}`,
        status: null,
        actorRole: null,
        bookingId: null,
        bookingDate: null,
        transcript: detail,
      });
    }

    const SEV_ICON: Record<string, string> = { critical: "🔴", warning: "🟠", info: "🔵" };
    for (const r of (watchdogRes.data ?? []) as Array<Record<string, unknown>>) {
      const sev = str(r.severity);
      const body = str(r.body).trim();
      items.push({
        id: `wd-${str(r.id)}`,
        kind: "watchdog",
        when: str(r.created_at),
        title: `${SEV_ICON[sev] ?? "🛡️"} ${str(r.title)}`,
        subtitle: body || null,
        status: null,
        actorRole: null,
        bookingId: null,
        bookingDate: null,
        transcript: body && body.length > 90 ? body : null,
      });
    }

    for (const r of (winbackRes.data ?? []) as Array<Record<string, unknown>>) {
      const name = str(r.client_name).trim() || "khách";
      const msg = str(r.message).trim();
      const visits = str(r.visit_count);
      const sent = str(r.status) === "sent";
      const due = str(r.kind) === "due";
      const verb = sent ? "Đã gửi" : "Gợi ý";
      const suggestionId = str(r.id);
      const undoActionId = (sent && suggestionId) ? (undoMap.get(suggestionId) ?? null) : null;
      items.push({
        id: `wb-${suggestionId}`,
        kind: "winback",
        when: str(r.created_at),
        title: due
          ? `⏰ ${verb} nhắc tới kỳ — ${name}${visits ? ` (${visits} lần)` : ""}`
          : `💌 ${verb} giữ khách — ${name}${visits ? ` (${visits} lần)` : ""}`,
        subtitle: msg || null,
        status: str(r.status) || null,
        actorRole: null,
        bookingId: null,
        bookingDate: null,
        transcript: msg
          ? `Khách: ${name} · đã đến ${visits || "?"} lần · ${due ? "tới kỳ quay lại" : "lâu chưa quay lại"}\nKênh đề xuất: ${str(r.channel) || "—"}\n\nLời nhắn AI soạn:\n${msg}`
          : null,
        undoActionId,
      });
    }

    items.sort((a, b) => Date.parse(b.when) - Date.parse(a.when));

    // Keep enough that no single source (each capped at PER_SOURCE) starves the
    // others in the merged "All" view; the tabs filter this full set.
    return { ok: true, items: items.slice(0, 200) };
  } catch (e) {
    console.error("[loadActivityFeed]", e);
    return { ok: false, error: "server_error" };
  }
}
