import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ aiRequired: true }));

vi.mock("@/shared/integrations/payments", () => ({
  resolvePaymentProvider: vi.fn(async () => ({ kind: "test" })),
}));

vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: () => ({
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        maybeSingle: async () => {
          if (table === "bookings") {
            return {
              data: {
                salon_id: "11111111-1111-4111-8111-111111111111",
                price_cents: 5_000,
                no_show_risk_score: 20,
                noshow_card_id: null,
                noshow_card_required: state.aiRequired,
                client_phone: "5555550100",
                group_id: null,
              },
            };
          }
          if (table === "salons") {
            return {
              data: {
                noshow_protection_enabled: true,
                noshow_fee_percent: 20,
                noshow_risk_threshold: 60,
                noshow_group_whole_party: true,
                noshow_deposit_escalation_threshold: null,
                noshow_require_new_customer: true,
                noshow_require_prior_noshow: true,
                noshow_min_noshow_count: 1,
                noshow_require_high_risk: true,
              },
            };
          }
          return { data: null };
        },
        limit: async () => ({ data: [{ status: "completed" }] }),
      };
      return builder;
    },
  }),
}));

import { noShowCardDecision } from "@/shared/integrations/square/noshow";

describe("AI-persisted no-show card requirement", () => {
  beforeEach(() => {
    state.aiRequired = true;
  });

  it("honors a guarded AI requirement and derives money from salon policy", async () => {
    await expect(noShowCardDecision("booking-1")).resolves.toMatchObject({
      required: true,
      feeCents: 1_000,
      reason: "booking policy requires card",
    });
  });

  it("keeps a clean returning customer friction-free without the persisted flag", async () => {
    state.aiRequired = false;

    await expect(noShowCardDecision("booking-1")).resolves.toMatchObject({
      required: false,
      feeCents: 0,
    });
  });
});
