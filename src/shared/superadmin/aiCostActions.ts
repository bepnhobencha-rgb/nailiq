import "server-only";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getSuperAdminRole } from "@/shared/lib/superadmin";

type UsageRow = {
  salon_id: string | null;
  feature: string;
  model: string;
  status: "succeeded" | "failed";
  estimated_cost_usd: number | string | null;
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
  };
}

async function isSuperadmin(): Promise<boolean> {
  const db = await createClient();
  const { data } = await db.auth.getUser();
  return Boolean(data.user && await getSuperAdminRole(data.user.id));
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
    const [usageResult, salonsResult, budgetsResult] = await Promise.all([
      db.from("ai_usage_events" as never)
        .select("salon_id, feature, model, status, estimated_cost_usd" as never)
        .gte("created_at" as never, monthStart)
        .order("created_at" as never, { ascending: false })
        .limit(limit),
      db.from("salons").select("id, name, slug").is("archived_at", null),
      db.from("ai_budget_policies" as never)
        .select("salon_id, monthly_budget_usd, warning_percent" as never),
    ]);
    if (usageResult.error || salonsResult.error || budgetsResult.error) {
      console.error("[superadmin/ai-costs] query unavailable", {
        usage: usageResult.error?.code,
        salons: salonsResult.error?.code,
        budgets: budgetsResult.error?.code,
      });
      return { ok: false, error: "unavailable" };
    }
    const usage = (usageResult.data ?? []) as unknown as UsageRow[];
    return {
      ok: true,
      data: summarizeAiCosts({
        usage,
        salons: (salonsResult.data ?? []) as SalonRow[],
        budgets: (budgetsResult.data ?? []) as unknown as BudgetRow[],
        monthStart,
        truncated: usage.length === limit,
      }),
    };
  } catch (error) {
    console.error("[superadmin/ai-costs] unavailable", error);
    return { ok: false, error: "unavailable" };
  }
}
