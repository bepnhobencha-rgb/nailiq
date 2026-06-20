import "server-only";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendOwnerAlert } from "@/shared/ai/sendOwnerAlert";

/**
 * Agent Huỷ Lịch / Cancellation Radar — Runs daily at 09:00.
 *
 * Tracks cancellation rate vs prior week. Two outputs:
 *  1. Spike alert → writes to watchdog_alerts (appears in digest's alert section)
 *     if cancellation rate rose by ≥10pp vs prior week AND rate > 20%.
 *  2. Weekly pattern email (Monday only) → day-of-week + per-staff breakdown
 *     via sendOwnerAlert (suppressed when ai_unified_digest is ON, but the
 *     ai_actions_log entry is always written for the digest to pick up).
 *
 * Feature flag: ai_cancellation_radar
 * Dedup: daily (one log per day per salon).
 */

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dowInTz(utcIso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).formatToParts(
    new Date(utcIso),
  );
  const abbr = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(abbr);
}

// ── Data collection ───────────────────────────────────────────────────────────

type CancellationSnapshot = {
  cancelCount: number;
  totalCount: number; // completed + no_show + cancelled
  ratePct: number;
  byDow: { day: string; count: number }[];
  byStaff: { name: string; count: number }[];
};

async function gatherCancellations(
  salonId: string,
  tz: string,
  weeksAgo: number,
): Promise<CancellationSnapshot> {
  const db = looseServiceClient();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const start = new Date(Date.now() - (weeksAgo + 1) * weekMs).toISOString();
  const end = new Date(Date.now() - weeksAgo * weekMs).toISOString();

  const { data } = await db
    .from("bookings" as never)
    .select("status, start_time_utc, staff:staff_id(name)" as never)
    .eq("salon_id" as never, salonId)
    .gte("start_time_utc" as never, start)
    .lt("start_time_utc" as never, end)
    .in("status" as never, [
      "completed",
      "no_show",
      "cancelled",
      "cancelled_before_window",
    ]);

  const rows = (data ?? []) as Row[];
  const cancelled = rows.filter((r) =>
    str(r.status).startsWith("cancelled"),
  );

  // By day of week
  const dowMap = new Map<number, number>();
  for (const r of cancelled) {
    const t = str(r.start_time_utc);
    if (!t) continue;
    const dow = dowInTz(t, tz);
    dowMap.set(dow, (dowMap.get(dow) ?? 0) + 1);
  }
  const byDow = Array.from(dowMap.entries())
    .map(([d, count]) => ({ day: DOW[d] ?? "Unknown", count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  // By staff
  const staffMap = new Map<string, number>();
  for (const r of cancelled) {
    const name = str((r.staff as Record<string, unknown> | null)?.name);
    if (!name) continue;
    staffMap.set(name, (staffMap.get(name) ?? 0) + 1);
  }
  const byStaff = Array.from(staffMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  const totalCount = rows.length;
  const cancelCount = cancelled.length;
  const ratePct = totalCount > 0 ? Math.round((cancelCount / totalCount) * 100) : 0;

  return { cancelCount, totalCount, ratePct, byDow, byStaff };
}

// ── Spike alert → watchdog_alerts ─────────────────────────────────────────────

function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function writeSpikeAlert(
  salonId: string,
  current: CancellationSnapshot,
  prior: CancellationSnapshot,
): Promise<void> {
  const diff = current.ratePct - prior.ratePct;
  // Only alert if rate jumped ≥10pp AND current rate is >20%
  if (diff < 10 || current.ratePct <= 20) return;

  const db = createServiceRoleClient();
  const dedupeKey = `cancellation_spike:${isoWeek(new Date())}`;
  const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await db
    .from("watchdog_alerts" as never)
    .select("id" as never)
    .eq("salon_id" as never, salonId)
    .eq("dedupe_key" as never, dedupeKey)
    .gte("created_at" as never, since)
    .limit(1);
  if (((recent ?? []) as unknown[]).length > 0) return;

  const worstDay = current.byDow[0]?.day ?? "";
  const title = `Tỷ lệ huỷ lịch tăng ${diff}pp tuần này`;
  const body = `Tuần này ${current.cancelCount} lịch bị huỷ (${current.ratePct}%), so với ${prior.ratePct}% tuần trước.${worstDay ? ` Ngày nhiều huỷ nhất: ${worstDay}.` : ""} Nên kiểm tra lý do và liên hệ lại khách hàng.`;

  await db.from("watchdog_alerts" as never).insert({
    salon_id: salonId,
    kind: "cancellation_spike",
    severity: current.ratePct >= 30 ? "critical" : "warning",
    title,
    body,
    summary: body,
    dedupe_key: dedupeKey,
    snapshot: { current, prior },
  } as never);
}

// ── Weekly pattern email (Monday only) ───────────────────────────────────────

function buildCancellationEmail(
  salonName: string,
  current: CancellationSnapshot,
  prior: CancellationSnapshot,
): { subject: string; bodyText: string; bodyHtml: string } {
  const esc = (x: string) =>
    x.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));

  const diff = current.ratePct - prior.ratePct;
  const diffColor = diff > 0 ? "#dc2626" : "#16a34a";
  const diffLabel = `${diff > 0 ? "+" : ""}${diff}pp so với tuần trước`;

  const dowRows = current.byDow
    .map(
      (r) =>
        `<tr><td style="padding:4px 12px 4px 0;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6">${esc(r.day)}</td><td style="padding:4px 0;font-size:13px;text-align:right;font-weight:600;border-bottom:1px solid #f3f4f6">${r.count} huỷ</td></tr>`,
    )
    .join("");

  const staffRows = current.byStaff
    .map(
      (r) =>
        `<tr><td style="padding:4px 12px 4px 0;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6">${esc(r.name)}</td><td style="padding:4px 0;font-size:13px;text-align:right;font-weight:600;border-bottom:1px solid #f3f4f6">${r.count} huỷ</td></tr>`,
    )
    .join("");

  const bodyHtml = `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:540px;color:#1a1a1a;padding:8px">
  <p style="font-size:11px;color:#999;margin:0 0 12px;text-transform:uppercase;letter-spacing:.08em">Radar Huỷ Lịch Tuần · ${esc(salonName)}</p>

  <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
    <tr>
      <td style="padding:12px;background:#f9fafb;border-radius:8px;text-align:center;width:48%">
        <p style="font-size:11px;color:#6b7280;margin:0 0 4px">Lịch Huỷ</p>
        <p style="font-size:20px;font-weight:700;margin:0">${current.cancelCount}</p>
      </td>
      <td style="width:8px"></td>
      <td style="padding:12px;background:#f9fafb;border-radius:8px;text-align:center;width:48%">
        <p style="font-size:11px;color:#6b7280;margin:0 0 4px">Tỷ Lệ Huỷ</p>
        <p style="font-size:20px;font-weight:700;margin:0">${current.ratePct}% <span style="color:${diffColor};font-size:13px">${diffLabel}</span></p>
      </td>
    </tr>
  </table>

  ${
    dowRows
      ? `<p style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin:0 0 6px">Ngày Nhiều Huỷ Nhất</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px">${dowRows}</table>`
      : ""
  }

  ${
    staffRows
      ? `<p style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin:0 0 6px">Nhân Viên Có Nhiều Huỷ</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:0">${staffRows}</table>`
      : ""
  }

  <p style="font-size:11px;color:#aaa;margin-top:20px">— Quản Lý AI · ${esc(salonName)}</p>
</div>`;

  const dowText = current.byDow.map((r) => `  ${r.day}: ${r.count} huỷ`).join("\n");
  const staffText = current.byStaff.map((r) => `  ${r.name}: ${r.count} huỷ`).join("\n");

  const bodyText = `${salonName} — Huỷ Lịch Tuần\n\nTổng: ${current.cancelCount} huỷ · Tỷ lệ: ${current.ratePct}% (${diffLabel})\n\nNgày nhiều huỷ:\n${dowText || "  (không có)"}\n\nNhân viên:\n${staffText || "  (không có)"}`;

  return {
    subject: `${salonName} · Huỷ Lịch Tuần: ${current.cancelCount} (${current.ratePct}%)`,
    bodyText,
    bodyHtml,
  };
}

// ── Daily dedup ───────────────────────────────────────────────────────────────

async function alreadyRanToday(salonId: string): Promise<boolean> {
  const db = createServiceRoleClient();
  const since = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from("ai_actions_log" as never)
    .select("id" as never)
    .eq("salon_id" as never, salonId)
    .eq("agent" as never, "cancellation_radar")
    .gte("created_at" as never, since)
    .limit(1);
  return ((data ?? []) as unknown[]).length > 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runCancellationRadar(salonId: string): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db
      .from("salons" as never)
      .select("name, timezone, feature_flags" as never)
      .eq("id" as never, salonId)
      .maybeSingle();

    const s = (salon as Row | null) ?? {};
    const flags = (s.feature_flags as Record<string, boolean> | null) ?? {};
    if (!flags.ai_cancellation_radar) return;
    if (await alreadyRanToday(salonId)) return;

    const salonName = str(s.name) || "our salon";
    const tz = str(s.timezone) || "America/Los_Angeles";

    const [current, prior] = await Promise.all([
      gatherCancellations(salonId, tz, 0),
      gatherCancellations(salonId, tz, 1),
    ]);

    if (current.totalCount < 5) {
      // Not enough data to be meaningful
      return;
    }

    // Always check for spikes (daily alert)
    await writeSpikeAlert(salonId, current, prior);

    // Monday: send full weekly pattern email
    const todayAbbr = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      weekday: "short",
    }).format(new Date());
    const isMonday = todayAbbr === "Mon";

    if (isMonday) {
      const { subject, bodyText, bodyHtml } = buildCancellationEmail(
        salonName,
        current,
        prior,
      );
      await sendOwnerAlert(salonId, { subject, bodyText, bodyHtml });
    }

    const svc = createServiceRoleClient();
    await svc.from("ai_actions_log" as never).insert({
      salon_id: salonId,
      agent: "cancellation_radar",
      action_type: isMonday ? "weekly_cancellation_report" : "daily_cancellation_check",
      target_id: null,
      payload: {
        cancelCount: current.cancelCount,
        cancellationRatePct: current.ratePct,
        priorWeekRatePct: prior.ratePct,
        spike: current.ratePct - prior.ratePct >= 10 && current.ratePct > 20,
        worstDow: current.byDow[0]?.day ?? null,
        worstStaff: current.byStaff[0]?.name ?? null,
      },
      undo_deadline: null,
    } as never);

    console.log(
      `[cancellation_radar] ${salonName}: ${current.cancelCount} cancellations (${current.ratePct}%)`,
    );
  } catch (e) {
    console.error("[runCancellationRadar]", e);
  }
}
