import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Outcome Tracker — did Minh's action actually bring the client back?
 *
 * Runs daily at 09:00 salon time. Finds pending actions sent 7-60 days ago,
 * checks if the client has a new booking afterward → marks converted / no_conversion.
 *
 * Window per agent (days to wait before declaring no_conversion):
 *   winback    21d — lapsed regulars take a few weeks to decide
 *   rebook     14d — rhythm-based, shorter window
 *   first_visit 28d — new clients need more time
 *   vip_care   30d — milestone messages, relaxed window
 */

const WINDOW_DAYS: Record<string, number> = {
  winback: 21,
  rebook: 14,
  first_visit: 28,
  vip_care: 30,
};

const TRACKABLE_AGENTS = Object.keys(WINDOW_DAYS);

export async function runOutcomeTracker(salonId: string): Promise<void> {
  const db = createServiceRoleClient();

  // Actions sent 7–60 days ago with no outcome yet
  const cutoffOld = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const cutoffNew = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const { data: actions } = await db
    .from("ai_actions_log" as never)
    .select("id, agent, created_at, payload")
    .eq("salon_id", salonId)
    .in("agent", TRACKABLE_AGENTS)
    .eq("action_type", "sent")
    .is("outcome", null)
    .gte("created_at", cutoffOld)
    .lte("created_at", cutoffNew);

  if (!actions?.length) return;

  const now = new Date();

  for (const row of actions as {
    id: string;
    agent: string;
    created_at: string;
    payload: Record<string, unknown> | null;
  }[]) {
    const phone = String(row.payload?.phone ?? "").trim();
    if (!phone) continue;

    const sentAt = new Date(row.created_at);
    const windowDays = WINDOW_DAYS[row.agent] ?? 21;
    const deadline = new Date(sentAt.getTime() + windowDays * 86_400_000);

    // Check if client booked after the message was sent
    const { data: booking } = await db
      .from("bookings")
      .select("id")
      .eq("salon_id", salonId)
      .eq("client_phone", phone)
      .gte("created_at", sentAt.toISOString())
      .not("status", "in", '("cancelled","cancelled_before_window","no_show")')
      .limit(1)
      .maybeSingle();

    if (booking) {
      await db
        .from("ai_actions_log" as never)
        .update({
          outcome: "converted",
          outcome_at: now.toISOString(),
          outcome_booking_id: (booking as { id: string }).id,
        } as never)
        .eq("id", row.id);
    } else if (now >= deadline) {
      await db
        .from("ai_actions_log" as never)
        .update({
          outcome: "no_conversion",
          outcome_at: now.toISOString(),
        } as never)
        .eq("id", row.id);
    }
    // else: window not yet expired — leave NULL, check again tomorrow
  }
}

/** Aggregated conversion stats for the last 30 days — used in digest context. */
export type OutcomeStats = {
  agent: string;
  label: string;
  sent: number;
  converted: number;
  pct: number;
};

const AGENT_LABELS: Record<string, string> = {
  winback: "Kéo Về",
  rebook: "Nhịp Tim",
  first_visit: "Lần đầu",
  vip_care: "VIP Care",
};

export async function getOutcomeStats(salonId: string): Promise<OutcomeStats[]> {
  const db = createServiceRoleClient();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const { data } = await db
    .from("ai_actions_log" as never)
    .select("agent, outcome")
    .eq("salon_id", salonId)
    .in("agent", TRACKABLE_AGENTS)
    .eq("action_type", "sent")
    .not("outcome", "is", null)
    .gte("created_at", since);

  const map = new Map<string, { sent: number; converted: number }>();
  for (const r of (data ?? []) as { agent: string; outcome: string }[]) {
    if (!map.has(r.agent)) map.set(r.agent, { sent: 0, converted: 0 });
    const s = map.get(r.agent)!;
    s.sent++;
    if (r.outcome === "converted") s.converted++;
  }

  return Array.from(map.entries()).map(([agent, s]) => ({
    agent,
    label: AGENT_LABELS[agent] ?? agent,
    sent: s.sent,
    converted: s.converted,
    pct: s.sent > 0 ? Math.round((s.converted / s.sent) * 100) : 0,
  }));
}
