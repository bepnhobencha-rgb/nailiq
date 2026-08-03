import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  resolveBudgetState,
  summarizeAiCosts,
} from "@/shared/superadmin/aiCostActions";

describe("AI cost dashboard", () => {
  it("classifies alert-only budget states", () => {
    expect(resolveBudgetState(1, null, null)).toBe("unconfigured");
    expect(resolveBudgetState(7.9, 10, 80)).toBe("ok");
    expect(resolveBudgetState(8, 10, 80)).toBe("warning");
    expect(resolveBudgetState(10, 10, 80)).toBe("exceeded");
  });

  it("aggregates spend by salon and feature without customer data", () => {
    const data = summarizeAiCosts({
      monthStart: "2026-08-01T00:00:00.000Z",
      salons: [{ id: "s1", name: "Salon", slug: "salon" }],
      budgets: [{ salon_id: "s1", monthly_budget_usd: 1, warning_percent: 80 }],
      usage: [
        { salon_id: "s1", feature: "noshow_policy", model: "haiku", status: "succeeded", estimated_cost_usd: 0.7 },
        { salon_id: "s1", feature: "noshow_policy", model: "haiku", status: "failed", estimated_cost_usd: null },
        { salon_id: "s1", feature: "noshow_risk_score", model: "haiku", status: "succeeded", estimated_cost_usd: "0.2" },
      ],
    });
    expect(data.calls).toBe(3);
    expect(data.failedCalls).toBe(1);
    expect(data.estimatedCostUsd).toBeCloseTo(0.9);
    expect(data.pricedCalls).toBe(2);
    expect(data.unpricedCalls).toBe(1);
    expect(data.salons[0]).toMatchObject({
      calls: 3,
      failedCalls: 1,
      budgetState: "warning",
    });
    expect(data.byFeature[0]).toMatchObject({
      feature: "noshow_policy",
      calls: 2,
    });
  });
});
