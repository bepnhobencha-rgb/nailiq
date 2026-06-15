"use server";

import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { isOwner } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

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

export type ActivityKind = "event" | "sms" | "email" | "call" | "system";

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
  /** Linked booking → deep-link target. */
  bookingId: string | null;
  /** Booking's salon-local date (YYYY-MM-DD) for the /center?date=&booking= link. */
  bookingDate: string | null;
  /** Full call transcript (call rows only). */
  transcript: string | null;
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

export async function loadActivityFeed(
  slug: string,
): Promise<LoadActivityFeedResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (!isOwner(resolved.role)) return { ok: false, error: "forbidden" };

  const salonId = resolved.salon.id;
  const db = createServiceRoleClient();

  try {
    const { data: salonRow } = await db
      .from("salons" as never)
      .select("timezone")
      .eq("id", salonId)
      .maybeSingle();
    const tz = (salonRow as { timezone?: string } | null)?.timezone || "America/Los_Angeles";

    const [eventsRes, notifsRes, callsRes, auditRes] = await Promise.all([
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
        .select("id, table_name, action, changed_fields, created_at")
        .eq("salon_id", salonId)
        .order("created_at", { ascending: false })
        .limit(PER_SOURCE),
    ]);

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

    for (const r of (callsRes.data ?? []) as Array<Record<string, unknown>>) {
      const name = str(r.client_name).trim() || str(r.client_phone) || "Cuộc gọi";
      const dur = Number(r.duration_seconds) || 0;
      const durStr = dur > 0 ? ` · ${Math.floor(dur / 60)}p${dur % 60}s` : "";
      items.push({
        id: `cl-${str(r.id)}`,
        kind: "call",
        when: str(r.created_at) || str(r.started_at),
        title: `Cuộc gọi AI · ${name}`,
        subtitle: `${str(r.status) || "—"}${durStr}`,
        status: str(r.status) || null,
        actorRole: null,
        bookingId: null,
        bookingDate: null,
        transcript: str(r.transcript) || null,
      });
    }

    for (const r of (auditRes.data ?? []) as Array<Record<string, unknown>>) {
      const changed = (r.changed_fields && typeof r.changed_fields === "object"
        ? (r.changed_fields as Record<string, unknown>)
        : {});
      const { title, subtitle } = describeAudit(str(r.table_name), str(r.action), changed);
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

    items.sort((a, b) => Date.parse(b.when) - Date.parse(a.when));

    // Keep enough that no single source (each capped at PER_SOURCE) starves the
    // others in the merged "All" view; the tabs filter this full set.
    return { ok: true, items: items.slice(0, 200) };
  } catch (e) {
    console.error("[loadActivityFeed]", e);
    return { ok: false, error: "server_error" };
  }
}
