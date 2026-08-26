import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { requireActiveSuperAdminSession } from "@/shared/auth/requireActiveSuperAdminSession";

type UsageRow = {
  salon_id: string | null;
  feature: string;
  model: string;
  status: "succeeded" | "failed";
  estimated_cost_usd: number | string | null;
  created_at?: string;
};

type OutcomeActionRow = {
  salon_id: string;
  agent: string;
  outcome: "converted" | "no_conversion" | null;
  outcome_booking_id: string | null;
};

type OutcomeBookingRow = {
  id: string;
  status: string;
  price_cents: number | null;
  addon_price_cents: number | null;
};

type SalonRow = { id: string; name: string; slug: string };
type BudgetRow = {
  salon_id: string;
  monthly_budget_usd: number | string;
  warning_percent: number;
};

export type BudgetState = "unconfigured" | "ok" | "warning" | "exceeded";

export type SalonAiCostRow = {
  salonId: string;
  salonName: string;
  slug: string;
  calls: number;
  failedCalls: number;
  estimatedCostUsd: number;
  monthlyBudgetUsd: number | null;
  warningPercent: number | null;
  budgetState: BudgetState;
};

export type AiCostDashboardData = {
  monthStart: string;
  calls: number;
  failedCalls: number;
  estimatedCostUsd: number;
  pricedCalls: number;
  unpricedCalls: number;
  truncated: boolean;
  salons: SalonAiCostRow[];
  byFeature: Array<{ feature: string; calls: number; costUsd: number }>;
  outcomeRoi: OutcomeRoiRow[];
};

export type OutcomeRoiRow = {
  salonId: string;
  salonName: string;
  slug: string;
  agent: string;
  agentLabel: string;
  acceptedDeliveries: number;
  bookings: number;
  completedAppointments: number;
  attributedRevenueUsd: number;
  estimatedAiCostUsd: number;
  costPerCompletedConversionUsd: number | null;
  observationDays: number;
  decisionReady: boolean;
};

const ROI_FEATURE_AGENT: Readonly<Record<string, string>> = {
  winback_draft: "winback",
  rebook_draft: "rebook",
  first_visit_draft: "first_visit",
  vip_care_draft: "vip_care",
};

const ROI_AGENT_LABEL: Readonly<Record<string, string>> = {
  winback: "Win-back",
  rebook: "Rebook",
  first_visit: "First visit",
  vip_care: "VIP care",
};

type LoadResult =
  | { ok: true; data: AiCostDashboardData }
  | { ok: false; error: "unauthorized" | "unavailable" };

function money(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function resolveBudgetState(
  spend: number,
  budget: number | null,
  warningPercent: number | null,
): BudgetState {
  if (budget === null || warningPercent === null) return "unconfigured";
  if (spend >= budget) return "exceeded";
  if (spend >= budget * (warningPercent / 100)) return "warning";
  return "ok";
}

export function summarizeAiCosts(input: {
  usage: UsageRow[];
  salons: SalonRow[];
  budgets: BudgetRow[];
  monthStart: string;
  truncated?: boolean;
  outcomeRoi?: OutcomeRoiRow[];
}): AiCostDashboardData {
  const budgetBySalon = new Map(input.budgets.map((row) => [row.salon_id, row]));
  const usageBySalon = new Map<string, UsageRow[]>();
  const featureMap = new Map<string, { calls: number; costUsd: number }>();

  for (const row of input.usage) {
    if (row.salon_id) {
      const group = usageBySalon.get(row.salon_id) ?? [];
      group.push(row);
      usageBySalon.set(row.salon_id, group);
    }
    const feature = featureMap.get(row.feature) ?? { calls: 0, costUsd: 0 };
    feature.calls += 1;
    feature.costUsd += money(row.estimated_cost_usd);
    featureMap.set(row.feature, feature);
  }

  const salons = input.salons.map((salon) => {
    const rows = usageBySalon.get(salon.id) ?? [];
    const policy = budgetBySalon.get(salon.id);
    const estimatedCostUsd = rows.reduce(
      (sum, row) => sum + money(row.estimated_cost_usd),
      0,
    );
    const monthlyBudgetUsd = policy ? money(policy.monthly_budget_usd) : null;
    const warningPercent = policy?.warning_percent ?? null;
    return {
      salonId: salon.id,
      salonName: salon.name,
      slug: salon.slug,
      calls: rows.length,
      failedCalls: rows.filter((row) => row.status === "failed").length,
      estimatedCostUsd,
      monthlyBudgetUsd,
      warningPercent,
      budgetState: resolveBudgetState(
        estimatedCostUsd,
        monthlyBudgetUsd,
        warningPercent,
      ),
    };
  }).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);

  return {
    monthStart: input.monthStart,
    calls: input.usage.length,
    failedCalls: input.usage.filter((row) => row.status === "failed").length,
    estimatedCostUsd: input.usage.reduce(
      (sum, row) => sum + money(row.estimated_cost_usd),
      0,
    ),
    pricedCalls: input.usage.filter((row) => row.estimated_cost_usd !== null).length,
    unpricedCalls: input.usage.filter((row) => row.estimated_cost_usd === null).length,
    truncated: input.truncated === true,
    salons,
    byFeature: [...featureMap.entries()]
      .map(([feature, value]) => ({ feature, ...value }))
      .sort((a, b) => b.costUsd - a.costUsd),
    outcomeRoi: input.outcomeRoi ?? [],
  };
}

export function summarizeOutcomeRoi(input: {
  usage: UsageRow[];
  actions: OutcomeActionRow[];
  bookings: OutcomeBookingRow[];
  salons: SalonRow[];
  nowIso: string;
}): OutcomeRoiRow[] {
  const salonById = new Map(input.salons.map((salon) => [salon.id, salon]));
  const bookingById = new Map(input.bookings.map((booking) => [booking.id, booking]));
  const keys = new Set<string>();
  for (const action of input.actions) keys.add(`${action.salon_id}:${action.agent}`);
  for (const event of input.usage) {
    const agent = ROI_FEATURE_AGENT[event.feature];
    if (event.salon_id && agent) keys.add(`${event.salon_id}:${agent}`);
  }

  return [...keys].flatMap((key) => {
    const separator = key.indexOf(":");
    const salonId = key.slice(0, separator);
    const agent = key.slice(separator + 1);
    const salon = salonById.get(salonId);
    if (!salon || !ROI_AGENT_LABEL[agent]) return [];

    const actions = input.actions.filter(
      (row) => row.salon_id === salonId && row.agent === agent,
    );
    const usage = input.usage.filter(
      (row) => row.salon_id === salonId && ROI_FEATURE_AGENT[row.feature] === agent,
    );
    const convertedBookingIds = new Set(
      actions
        .filter((row) => row.outcome === "converted" && row.outcome_booking_id)
        .map((row) => row.outcome_booking_id as string),
    );
    const completedBookings = [...convertedBookingIds]
      .map((id) => bookingById.get(id))
      .filter((booking): booking is OutcomeBookingRow => booking?.status === "completed");
    const estimatedAiCostUsd = usage.reduce(
      (sum, row) => sum + money(row.estimated_cost_usd),
      0,
    );
    const firstUsageAt = usage
      .map((row) => row.created_at)
      .filter((value): value is string => Boolean(value))
      .sort()[0];
    const observationDays = firstUsageAt
      ? Math.max(0, Math.floor((Date.parse(input.nowIso) - Date.parse(firstUsageAt)) / 86_400_000))
      : 0;
    const completedAppointments = completedBookings.length;

    return [{
      salonId,
      salonName: salon.name,
      slug: salon.slug,
      agent,
      agentLabel: ROI_AGENT_LABEL[agent],
      acceptedDeliveries: actions.length,
      bookings: convertedBookingIds.size,
      completedAppointments,
      attributedRevenueUsd: completedBookings.reduce(
        (sum, booking) => sum + Math.max(0, (booking.price_cents ?? 0) + (booking.addon_price_cents ?? 0)),
        0,
      ) / 100,
      estimatedAiCostUsd,
      costPerCompletedConversionUsd: completedAppointments > 0
        ? estimatedAiCostUsd / completedAppointments
        : null,
      observationDays,
      decisionReady: observationDays >= 14,
    }];
  }).sort((a, b) => b.attributedRevenueUsd - a.attributedRevenueUsd);
}

async function isSuperadmin(): Promise<boolean> {
  return (await requireActiveSuperAdminSession()).ok;
}

export async function loadAiCostDashboard(): Promise<LoadResult> {
  if (!(await isSuperadmin())) return { ok: false, error: "unauthorized" };

  try {
    const db = createServiceRoleClient();
    const now = new Date();
    const monthStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      1,
    )).toISOString();
    const limit = 10_000;
    const roiSince = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [usageResult, roiUsageResult, actionsResult, salonsResult, budgetsResult] = await Promise.all([
      db.from("ai_usage_events" as never)
        .select("salon_id, feature, model, status, estimated_cost_usd" as never)
        .gte("created_at" as never, monthStart)
        .order("created_at" as never, { ascending: false })
        .limit(limit),
      db.from("ai_usage_events" as never)
        .select("salon_id, feature, model, status, estimated_cost_usd, created_at" as never)
        .gte("created_at" as never, roiSince)
        .in("feature" as never, Object.keys(ROI_FEATURE_AGENT))
        .order("created_at" as never, { ascending: false })
        .limit(limit),
      db.from("ai_actions_log" as never)
        .select("salon_id, agent, outcome, outcome_booking_id" as never)
        .gte("created_at" as never, roiSince)
        .in("agent" as never, Object.values(ROI_FEATURE_AGENT))
        .neq("action_type" as never, "skipped_no_channel")
        .limit(limit),
      db.from("salons").select("id, name, slug").is("archived_at", null),
      db.from("ai_budget_policies" as never)
        .select("salon_id, monthly_budget_usd, warning_percent" as never),
    ]);
    if (usageResult.error || roiUsageResult.error || actionsResult.error || salonsResult.error || budgetsResult.error) {
      console.error("[superadmin/ai-costs] query unavailable", {
        usage: usageResult.error?.code,
        roiUsage: roiUsageResult.error?.code,
        actions: actionsResult.error?.code,
        salons: salonsResult.error?.code,
        budgets: budgetsResult.error?.code,
      });
      return { ok: false, error: "unavailable" };
    }
    const usage = (usageResult.data ?? []) as unknown as UsageRow[];
    const actions = (actionsResult.data ?? []) as unknown as OutcomeActionRow[];
    const bookingIds = [...new Set(actions
      .map((row) => row.outcome_booking_id)
      .filter((id): id is string => Boolean(id)))];
    const bookingsResult = bookingIds.length > 0
      ? await db.from("bookings")
          .select("id, status, price_cents, addon_price_cents")
          .in("id", bookingIds)
      : { data: [] as OutcomeBookingRow[], error: null };
    if (bookingsResult.error) {
      console.error("[superadmin/ai-costs] booking outcomes unavailable", bookingsResult.error.code);
      return { ok: false, error: "unavailable" };
    }
    const salons = (salonsResult.data ?? []) as SalonRow[];
    const outcomeRoi = summarizeOutcomeRoi({
      usage: (roiUsageResult.data ?? []) as unknown as UsageRow[],
      actions,
      bookings: (bookingsResult.data ?? []) as OutcomeBookingRow[],
      salons,
      nowIso: now.toISOString(),
    });
    return {
      ok: true,
      data: summarizeAiCosts({
        usage,
        salons,
        budgets: (budgetsResult.data ?? []) as unknown as BudgetRow[],
        monthStart,
        truncated: usage.length === limit,
        outcomeRoi,
      }),
    };
  } catch (error) {
    console.error("[superadmin/ai-costs] unavailable", error);
    return { ok: false, error: "unavailable" };
  }
}
