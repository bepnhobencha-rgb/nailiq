import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  resolveBudgetState,
  summarizeAiCosts,
  summarizeOutcomeRoi,
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

  it("connects accepted actions to unique bookings, completed revenue, and cost", () => {
    const rows = summarizeOutcomeRoi({
      nowIso: "2026-08-20T00:00:00.000Z",
      salons: [{ id: "s1", name: "Salon", slug: "salon" }],
      usage: [
        { salon_id: "s1", feature: "winback_draft", model: "haiku", status: "succeeded", estimated_cost_usd: 0.12, created_at: "2026-08-01T00:00:00.000Z" },
        { salon_id: "s1", feature: "winback_draft", model: "haiku", status: "succeeded", estimated_cost_usd: 0.08, created_at: "2026-08-02T00:00:00.000Z" },
      ],
      actions: [
        { salon_id: "s1", agent: "winback", outcome: "converted", outcome_booking_id: "b1" },
        // Repeated action attribution must not count the same booking twice.
        { salon_id: "s1", agent: "winback", outcome: "converted", outcome_booking_id: "b1" },
        { salon_id: "s1", agent: "winback", outcome: null, outcome_booking_id: null },
      ],
      bookings: [
        { id: "b1", status: "completed", price_cents: 5000, addon_price_cents: 1000 },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      acceptedDeliveries: 3,
      bookings: 1,
      completedAppointments: 1,
      attributedRevenueUsd: 60,
      estimatedAiCostUsd: 0.2,
      costPerCompletedConversionUsd: 0.2,
      observationDays: 19,
      decisionReady: true,
    });
  });

  it("never counts booked-but-incomplete appointments as revenue or conversions", () => {
    const [row] = summarizeOutcomeRoi({
      nowIso: "2026-08-10T00:00:00.000Z",
      salons: [{ id: "s1", name: "Salon", slug: "salon" }],
      usage: [{ salon_id: "s1", feature: "rebook_draft", model: "haiku", status: "succeeded", estimated_cost_usd: 0.1, created_at: "2026-08-09T00:00:00.000Z" }],
      actions: [{ salon_id: "s1", agent: "rebook", outcome: "converted", outcome_booking_id: "b1" }],
      bookings: [{ id: "b1", status: "confirmed", price_cents: 14900, addon_price_cents: null }],
    });

    expect(row.bookings).toBe(1);
    expect(row.completedAppointments).toBe(0);
    expect(row.attributedRevenueUsd).toBe(0);
    expect(row.costPerCompletedConversionUsd).toBeNull();
    expect(row.decisionReady).toBe(false);
  });
});
