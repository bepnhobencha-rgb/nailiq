import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  claimAiExecutionSlot,
  ruleFirstOptimizationEnabled,
} from "@/shared/ai/executionLimit";
import { trackAnthropicMessage } from "@/shared/ai/usageLedger";

/**
 * AI Watchdog — proactive owner alerts. A daily-ish agent (piggybacks on the
 * square-sync cron, throttled per salon) scans recent operational data and lets
 * an AI judge whether anything is worth the owner's attention, in plain language.
 *
 * Same "AI brain on a deterministic spine" pattern as the no-show agent:
 *  - gatherOpsSnapshot: pull the metrics (deterministic),
 *  - agentWatchdogAssess: AI prioritises + writes owner-friendly alerts,
 *  - guardWatchdog: clamp severity, cap count, drop junk,
 *  - runWatchdog: throttle + dedupe + log to watchdog_alerts (the owner reviews
 *    in the Activity feed). The AI only SURFACES — it never acts.
 */

const str = (v: unknown): string => (v == null ? "" : String(v));

export type OpsSnapshot = {
  salonId: string;
  salonName: string;
  noShow7d: number;
  noShowPrev7d: number;
  noShowWithCard7d: number;
  created7d: number;
  createdPrev7d: number;
  tomorrowBooked: number;
  next7dBooked: number;
  upcomingHighRiskUnprotected: number;
  syncError: string | null;
  syncStaleMinutes: number | null;
};

export type WatchdogAlert = {
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
};

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

const SEVERITIES = new Set(["info", "warning", "critical"]);

/** Pull the operational snapshot the watchdog reasons over. */
export async function gatherOpsSnapshot(salonId: string): Promise<OpsSnapshot | null> {
  const db = looseServiceClient();
  const { data: salon } = await db
    .from("salons")
    .select("name")
    .eq("id", salonId)
    .maybeSingle();
  if (!salon) return null;

  const nowIso = new Date().toISOString();
  const d7 = new Date(Date.now() - 7 * 864e5).toISOString();
  const d14 = new Date(Date.now() - 14 * 864e5).toISOString();
  const next7 = new Date(Date.now() + 7 * 864e5).toISOString();
  const next14 = new Date(Date.now() + 14 * 864e5).toISOString();

  // head+count select needs the `as any` escape hatch (the loose client's typed
  // select() rejects the count option). One helper keeps the call sites tidy.
  const q = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.from("bookings") as any).select("id", { count: "exact", head: true }).eq("salon_id", salonId);
  const count = async (chain: unknown): Promise<number> => {
    const { count: c } = (await chain) as { count: number | null };
    return c ?? 0;
  };

  const [
    noShow7d,
    noShowPrev7d,
    noShowWithCard7d,
    created7d,
    createdPrev7d,
    tomorrowBooked,
    next7dBooked,
    upcomingHighRiskUnprotected,
    { data: sq },
  ] = await Promise.all([
    count(q().eq("status", "no_show").gte("start_time_utc", d7)),
    count(q().eq("status", "no_show").gte("start_time_utc", d14).lt("start_time_utc", d7)),
    count(q().eq("status", "no_show").gte("start_time_utc", d7).not("noshow_card_id", "is", null)),
    count(q().gte("created_at", d7)),
    count(q().gte("created_at", d14).lt("created_at", d7)),
    count(q().in("status", ["confirmed", "pending"]).gte("start_time_utc", nowIso).lt("start_time_utc", new Date(Date.now() + 864e5).toISOString())),
    count(q().in("status", ["confirmed", "pending"]).gte("start_time_utc", nowIso).lt("start_time_utc", next7)),
    count(q().in("status", ["confirmed", "pending"]).gte("start_time_utc", nowIso).lt("start_time_utc", next14).gte("no_show_risk_score", 70).is("noshow_card_id", null)),
    db.from("square_integrations").select("last_error, last_run_at").eq("salon_id", salonId).maybeSingle(),
  ]);

  const sqRow = (sq as Row | null) ?? {};
  const lastRun = sqRow.last_run_at ? Date.parse(str(sqRow.last_run_at)) : null;
  const syncStaleMinutes = lastRun ? Math.round((Date.now() - lastRun) / 60000) : null;

  return {
    salonId,
    salonName: str((salon as Row).name) || "Salon",
    noShow7d,
    noShowPrev7d,
    noShowWithCard7d,
    created7d,
    createdPrev7d,
    tomorrowBooked,
    next7dBooked,
    upcomingHighRiskUnprotected,
    syncError: str(sqRow.last_error) || null,
    syncStaleMinutes,
  };
}

/** ① AI BRAIN — prioritise the snapshot into owner alerts. null on failure. */
export async function agentWatchdogAssess(snap: OpsSnapshot): Promise<WatchdogAlert[] | null> {
  const ai = getClient();
  if (!ai) return null;

  const prompt = `Bạn là trợ lý vận hành cho một salon. Dưới đây là số liệu tuần qua. Hãy CHỈ cảnh báo chủ tiệm về những gì THỰC SỰ đáng chú ý (bất thường, mất tiền, rủi ro), bằng giọng ngắn gọn, rõ ràng, hành động được. Nếu mọi thứ ổn → trả mảng rỗng [].

Số liệu của ${snap.salonName}:
- No-show 7 ngày qua: ${snap.noShow7d} (7 ngày trước đó: ${snap.noShowPrev7d})
- Trong số no-show đó, số có lưu thẻ: ${snap.noShowWithCard7d} (không lưu thẻ = mất phí)
- Lịch hẹn MỚI tạo 7 ngày: ${snap.created7d} (7 ngày trước đó: ${snap.createdPrev7d})
- Đã đặt cho ngày mai: ${snap.tomorrowBooked} | cho 7 ngày tới: ${snap.next7dBooked}
- Lịch sắp tới rủi ro cao mà CHƯA có thẻ bảo vệ: ${snap.upcomingHighRiskUnprotected}
- Đồng bộ Square: ${snap.syncError ? `LỖI: ${snap.syncError}` : "ổn"}${snap.syncStaleMinutes != null ? `, chạy lần cuối ${snap.syncStaleMinutes} phút trước` : ""}

Mỗi cảnh báo gồm: kind (no_show_spike|protection_gap|sync_stuck|low_bookings|demand_drop|other), severity (info|warning|critical), title (ngắn), message (1-2 câu, có gợi ý nên làm gì).
Chỉ trả JSON: {"alerts":[{"kind":"...","severity":"...","title":"...","message":"..."}]}`;

  try {
    const model = "claude-haiku-4-5-20251001";
    const resp = await trackAnthropicMessage(
      { salonId: snap.salonId, feature: "watchdog", model },
      () => ai.messages.create({
        model,
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }],
      }),
    );
    const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as { alerts?: unknown };
    if (!Array.isArray(parsed.alerts)) return [];
    return parsed.alerts
      .map((a) => a as Partial<WatchdogAlert>)
      .filter((a) => a && typeof a.title === "string" && a.title.trim())
      .map((a) => ({
        kind: typeof a.kind === "string" ? a.kind : "other",
        severity: SEVERITIES.has(String(a.severity)) ? (a.severity as WatchdogAlert["severity"]) : "info",
        title: String(a.title).trim(),
        message: typeof a.message === "string" ? a.message.trim() : "",
      }));
  } catch {
    return null;
  }
}

export function hasMaterialWatchdogSignal(snap: OpsSnapshot): boolean {
  const noShowSpike =
    snap.noShow7d >= 2 && snap.noShow7d >= Math.max(2, snap.noShowPrev7d * 2);
  const demandDrop =
    snap.createdPrev7d >= 5 && snap.created7d <= Math.floor(snap.createdPrev7d / 2);
  return Boolean(
    snap.syncError ||
      (snap.syncStaleMinutes != null && snap.syncStaleMinutes >= 180) ||
      snap.upcomingHighRiskUnprotected > 0 ||
      noShowSpike ||
      demandDrop,
  );
}

/** ② CODE SPINE — clamp + cap. Drops empty, caps at 4, info-only when unsure. */
export function guardWatchdog(alerts: WatchdogAlert[] | null): WatchdogAlert[] {
  if (!alerts) return [];
  return alerts
    .filter((a) => a.title)
    .slice(0, 4)
    .map((a) => ({
      ...a,
      severity: SEVERITIES.has(a.severity) ? a.severity : "info",
      title: a.title.slice(0, 120),
      message: (a.message || "").slice(0, 400),
    }));
}

/**
 * Run the watchdog for one salon. Throttled to ~once/12h via watchdog_state,
 * gated on the salon's `ai_watchdog` opt-in flag. Dedupes alerts by
 * kind + ISO-week so the same standing issue isn't re-posted daily. Best-effort.
 */
export async function runWatchdog(salonId: string): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db.from("salons").select("feature_flags").eq("id", salonId).maybeSingle();
    const flags = (salon as Row | null)?.feature_flags as Record<string, unknown> | null;
    if (flags?.ai_watchdog !== true) return; // opt-in only

    // Throttle: skip if we ran in the last 12h.
    const { data: state } = await db.from("watchdog_state").select("last_run_at").eq("salon_id", salonId).maybeSingle();
    const last = (state as Row | null)?.last_run_at ? Date.parse(str((state as Row).last_run_at)) : 0;
    if (last && Date.now() - last < 12 * 3600 * 1000) return;

    const snap = await gatherOpsSnapshot(salonId);
    if (!snap) return;

    const svc = createServiceRoleClient();
    // Persist the cadence before any model call so failures, conditional skips,
    // and concurrent workers cannot hammer the provider.
    await svc.from("watchdog_state" as never).upsert(
      { salon_id: salonId, last_run_at: new Date().toISOString() } as never,
      { onConflict: "salon_id" } as never,
    );

    if (ruleFirstOptimizationEnabled(flags)) {
      if (!hasMaterialWatchdogSignal(snap)) return;
      const claimed = await claimAiExecutionSlot({
        salonId,
        feature: "watchdog",
        dedupeKey: String(Math.floor(Date.now() / (12 * 3600 * 1000))),
        windowSeconds: 86400,
        maxCalls: 2,
      });
      if (!claimed) return;
    }

    const assessed = await agentWatchdogAssess(snap);
    const alerts = guardWatchdog(assessed);

    if (alerts.length === 0) return;

    // Dedupe: kind + ISO-week bucket; skip if the same key exists in the last 20h.
    const weekBucket = isoWeek(new Date());
    const since = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
    const { data: recent } = await db
      .from("watchdog_alerts")
      .select("dedupe_key")
      .eq("salon_id", salonId)
      .gte("created_at", since);
    const seen = new Set(((recent ?? []) as Row[]).map((r) => str(r.dedupe_key)));

    const rows = alerts
      .map((a) => ({ a, dedupe_key: `${a.kind}:${weekBucket}` }))
      .filter(({ dedupe_key }) => !seen.has(dedupe_key))
      .map(({ a, dedupe_key }) => ({
        salon_id: salonId,
        kind: a.kind,
        severity: a.severity,
        title: a.title,
        body: a.message,
        dedupe_key,
        snapshot: snap as unknown,
      }));

    if (rows.length > 0) {
      await svc.from("watchdog_alerts" as never).insert(rows as never);
    }
  } catch (e) {
    console.error("[runWatchdog]", e);
    throw e;
  }
}

/** ISO-week string like "2026-W24" for dedupe bucketing. */
function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
