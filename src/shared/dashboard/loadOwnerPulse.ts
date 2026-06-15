"use server";

import { unstable_cache } from "next/cache";
import Anthropic from "@anthropic-ai/sdk";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  salonToday,
  salonDateOffset,
  salonDayRangeUtc,
} from "@/shared/lib/salonTime";

/**
 * Owner "Pulse" — a remote, phone-first digest for an owner/admin who is
 * NOT at the salon. One aggregator pulls today's money + live-busy +
 * attention signals so the page renders the whole picture from a single
 * server roundtrip, plus an optional 2-sentence AI briefing.
 */

const NO_SHOW_RISK_THRESHOLD = 60; // score ≥ this = worth flagging
const TOMORROW_LOW_BOOKINGS = 4; // < this on tomorrow = nudge

export type PulseAttentionKind =
  | "overdue"
  | "not_started"
  | "no_show_risk"
  | "tomorrow_low";

export type PulseAttention = {
  kind: PulseAttentionKind;
  count: number;
};

export type PulseStaff = {
  id: string;
  name: string;
  status: "busy" | "available";
};

/** What the "in service" ring counts — a physical resource kind, or staff
 *  headcount when the salon hasn't set up the resource layer. */
export type CapacityKind = "bed" | "chair" | "room" | "station" | "staff";

const KNOWN_KINDS: CapacityKind[] = ["bed", "chair", "room", "station"];

function dominantKind(rows: { kind: string | null }[]): CapacityKind {
  const tally = new Map<string, number>();
  for (const r of rows) {
    const k = (r.kind ?? "").trim().toLowerCase();
    if (k) tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  let best: CapacityKind = "chair";
  let bestN = 0;
  for (const k of KNOWN_KINDS) {
    const n = tally.get(k) ?? 0;
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

export type OwnerPulseData = {
  salonName: string;
  timezone: string;
  salonPhone: string | null;
  // Live busy
  chairsBusy: number;
  chairsTotal: number;
  capacityKind: CapacityKind;
  // Money (cents)
  revenueTodayCents: number;
  revenueBenchmarkCents: number; // last week, same weekday (completed)
  // Today counts
  totalToday: number;
  completedToday: number;
  remainingToday: number;
  noShowToday: number;
  walkinToday: number;
  // Attention
  attention: PulseAttention[];
  tomorrowCount: number;
  // Team
  staff: PulseStaff[];
  // AI
  briefing: string | null;
  generatedAtUtc: string;
};

export type LoadOwnerPulseResult =
  | { ok: true; data: OwnerPulseData }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

type BookingLite = {
  status: string;
  price_cents: number | null;
  start_time_utc: string | null;
  end_time_utc: string | null;
  staff_id: string | null;
  resource_id: string | null;
  no_show_risk_score: number | null;
  booking_channel: string | null;
  source: string | null;
};

export async function loadOwnerPulse(
  slug: string,
  language: "en" | "vi" = "en",
): Promise<LoadOwnerPulseResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    return { ok: false, error: "forbidden" };
  }

  try {
    const tz = ctx.salon.timezone;
    const nowIso = new Date().toISOString();
    const todayYmd = salonToday(tz);
    const tomorrowYmd = salonDateOffset(tz, 1);
    const lastWeekYmd = salonDateOffset(tz, -7);

    const today = salonDayRangeUtc(todayYmd, tz);
    const tomorrow = salonDayRangeUtc(tomorrowYmd, tz);
    const lastWeek = salonDayRangeUtc(lastWeekYmd, tz);

    const sb = ctx.supabase;
    const salonId = ctx.salon.id;

    const [todayRes, tomorrowRes, benchRes, staffRes, resourcesRes] =
      await Promise.all([
      sb
        .from("bookings")
        .select(
          "status, price_cents, start_time_utc, end_time_utc, staff_id, resource_id, no_show_risk_score, booking_channel, source",
        )
        .eq("salon_id", salonId)
        .gte("start_time_utc", today.startUtc)
        .lt("start_time_utc", today.endUtc),
      sb
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("salon_id", salonId)
        .gte("start_time_utc", tomorrow.startUtc)
        .lt("start_time_utc", tomorrow.endUtc)
        .neq("status", "cancelled"),
      sb
        .from("bookings")
        .select("price_cents")
        .eq("salon_id", salonId)
        .eq("status", "completed")
        .gte("start_time_utc", lastWeek.startUtc)
        .lt("start_time_utc", lastWeek.endUtc),
      sb
        .from("staff")
        .select("id, name, status")
        .eq("salon_id", salonId)
        .eq("status", "active"),
      // Physical capacity (beds/chairs/stations). When a salon has configured
      // resources we measure "in service" against THEM, not staff headcount.
      sb
        .from("salon_resources")
        .select("id, kind")
        .eq("salon_id", salonId)
        .eq("status", "active")
        .is("deleted_at", null),
    ]);

    const rows = (todayRes.data ?? []) as BookingLite[];
    const isWalkin = (b: BookingLite) =>
      b.booking_channel === "walkin" || b.source === "walkin";

    let completedToday = 0;
    let noShowToday = 0;
    let walkinToday = 0;
    let revenueTodayCents = 0;
    let remainingToday = 0;
    let overdue = 0;
    let notStarted = 0;
    let noShowRisk = 0;
    const busyStaffIds = new Set<string>();
    const busyResourceIds = new Set<string>();
    let inProgressNow = 0;

    for (const b of rows) {
      if (isWalkin(b)) walkinToday += 1;
      const start = b.start_time_utc;
      const end = b.end_time_utc;
      switch (b.status) {
        case "completed":
          completedToday += 1;
          revenueTodayCents += b.price_cents ?? 0;
          break;
        case "no_show":
          noShowToday += 1;
          break;
        case "in_progress":
          inProgressNow += 1;
          if (b.staff_id) busyStaffIds.add(b.staff_id);
          if (b.resource_id) busyResourceIds.add(b.resource_id);
          if (end && end < nowIso) overdue += 1;
          break;
        case "confirmed":
        case "pending":
          remainingToday += 1;
          if (start && start < nowIso) notStarted += 1;
          else if ((b.no_show_risk_score ?? 0) >= NO_SHOW_RISK_THRESHOLD)
            noShowRisk += 1;
          break;
        default:
          break;
      }
    }

    const benchRevenue = ((benchRes.data ?? []) as { price_cents: number | null }[]).reduce(
      (sum, r) => sum + (r.price_cents ?? 0),
      0,
    );

    const staffRows = (staffRes.data ?? []) as {
      id: string;
      name: string | null;
      status: string;
    }[];
    // "Chairs in service" = physical capacity. Prefer the salon's configured
    // resources (beds/chairs/stations); fall back to active-staff headcount for
    // salons that haven't set up the resource layer, so nothing breaks for them.
    const resourceRows = (resourcesRes.data ?? []) as { kind: string | null }[];
    const resourceCount = resourceRows.length;
    const usingResources = resourceCount > 0;
    const chairsTotal = usingResources ? resourceCount : staffRows.length;
    // Unit label for the ring — the dominant resource kind (bed/chair/room…),
    // or "staff" when we fell back to headcount.
    const capacityKind: CapacityKind = usingResources
      ? dominantKind(resourceRows)
      : "staff";
    // Occupied chairs = distinct resources in use when bookings carry a
    // resource_id; otherwise every in-progress service occupies one chair
    // (capped at capacity) so the number is right even before resource
    // scheduling assigns ids.
    // Cap at capacity: a booking can reference a since-deactivated resource
    // (counted in busyResourceIds but not in the active resourceCount), which
    // would otherwise show e.g. 4/3 and overflow the ring.
    const chairsBusy = Math.min(
      usingResources
        ? busyResourceIds.size > 0
          ? busyResourceIds.size
          : inProgressNow
        : busyStaffIds.size,
      chairsTotal,
    );
    const staff: PulseStaff[] = staffRows
      .map((s) => ({
        id: s.id,
        name: (s.name ?? "").trim() || "—",
        status: busyStaffIds.has(s.id)
          ? ("busy" as const)
          : ("available" as const),
      }))
      // Busy first so the owner sees who's working at a glance.
      .sort((a, b) => (a.status === b.status ? 0 : a.status === "busy" ? -1 : 1));

    const tomorrowCount = tomorrowRes.count ?? 0;

    const attention: PulseAttention[] = [];
    if (overdue > 0) attention.push({ kind: "overdue", count: overdue });
    if (notStarted > 0)
      attention.push({ kind: "not_started", count: notStarted });
    if (noShowRisk > 0)
      attention.push({ kind: "no_show_risk", count: noShowRisk });
    if (tomorrowCount < TOMORROW_LOW_BOOKINGS)
      attention.push({ kind: "tomorrow_low", count: tomorrowCount });

    const briefing = await getCachedBriefing({
      salonId,
      day: todayYmd,
      language,
      revenueTodayCents,
      benchRevenue,
      totalToday: rows.length,
      completedToday,
      remainingToday,
      noShowToday,
      chairsBusy,
      chairsTotal,
      overdue,
      tomorrowCount,
    });

    return {
      ok: true,
      data: {
        salonName: (ctx.salon.name ?? "").trim() || slug,
        timezone: tz,
        salonPhone:
          (ctx.salon as { salon_phone?: string | null }).salon_phone ??
          (ctx.salon as { phone?: string | null }).phone ??
          null,
        chairsBusy,
        chairsTotal,
        capacityKind,
        revenueTodayCents,
        revenueBenchmarkCents: benchRevenue,
        totalToday: rows.length,
        completedToday,
        remainingToday,
        noShowToday,
        walkinToday,
        attention,
        tomorrowCount,
        staff,
        briefing,
        generatedAtUtc: nowIso,
      },
    };
  } catch {
    return { ok: false, error: "server_error" };
  }
}

type BriefingInput = {
  salonId: string;
  day: string;
  language: "en" | "vi";
  revenueTodayCents: number;
  benchRevenue: number;
  totalToday: number;
  completedToday: number;
  remainingToday: number;
  noShowToday: number;
  chairsBusy: number;
  chairsTotal: number;
  overdue: number;
  tomorrowCount: number;
};

/**
 * Cache the AI briefing keyed on a coarse signature of the day's picture so
 * it regenerates only when something meaningful changes — not on every page
 * load. Revenue is bucketed to the nearest $20 to avoid churn.
 */
async function getCachedBriefing(input: BriefingInput): Promise<string | null> {
  const revBucket = Math.round(input.revenueTodayCents / 2000);
  const sig = [
    input.salonId,
    input.day,
    input.language,
    revBucket,
    input.completedToday,
    input.remainingToday,
    input.noShowToday,
    input.chairsBusy,
    input.overdue,
    input.tomorrowCount,
  ].join(":");

  const cached = unstable_cache(
    () => generateBriefing(input),
    ["owner-pulse-briefing", sig],
    { revalidate: 600, tags: [`pulse-${input.salonId}`] },
  );
  return cached();
}

async function generateBriefing(input: BriefingInput): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  const money = (c: number) => `$${(c / 100).toFixed(0)}`;
  const vsBench =
    input.benchRevenue > 0
      ? Math.round((input.revenueTodayCents / input.benchRevenue) * 100)
      : null;

  // Deterministic fallback when no API key — never leave the card empty.
  const fallback =
    input.language === "vi"
      ? `Hôm nay ${money(input.revenueTodayCents)} doanh thu, ${input.completedToday} xong / ${input.remainingToday} còn lại${input.noShowToday ? `, ${input.noShowToday} no-show` : ""}.`
      : `Today ${money(input.revenueTodayCents)} revenue, ${input.completedToday} done / ${input.remainingToday} to go${input.noShowToday ? `, ${input.noShowToday} no-show` : ""}.`;

  if (!key) return fallback;

  try {
    const anthropic = new Anthropic({ apiKey: key });
    const facts = {
      revenue_today: money(input.revenueTodayCents),
      vs_last_week_same_day_percent: vsBench,
      total_appointments: input.totalToday,
      completed: input.completedToday,
      remaining: input.remainingToday,
      no_show: input.noShowToday,
      chairs_busy_now: input.chairsBusy,
      chairs_total: input.chairsTotal,
      overdue_in_progress: input.overdue,
      tomorrow_booked: input.tomorrowCount,
    };
    const lang =
      input.language === "vi"
        ? "Vietnamese (tiếng Việt, thân thiện, ngắn gọn)"
        : "English (friendly, concise)";
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 160,
      messages: [
        {
          role: "user",
          content: `You are a salon owner's assistant. Write EXACTLY 2 short sentences in ${lang} summarizing how the salon is doing today for an owner who is away. Lead with the most important signal (money vs last week, or an attention item). Be specific with numbers, warm, no fluff, no markdown, no emoji. Facts: ${JSON.stringify(facts)}`,
        },
      ],
    });
    const text = resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}
