import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/shared/integrations/payments", () => ({
  resolvePaymentProvider: vi.fn(async () => ({ kind: "square" })),
}));

vi.mock("@/shared/integrations/square/client", () => ({
  getSquareConfig: vi.fn(async () => ({
    applicationId: "sq0idp_test",
    locationId: "location_test",
    environment: "sandbox",
  })),
}));

vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        maybeSingle: async () => ({
          data:
            table === "salons"
              ? {
                  noshow_protection_enabled: true,
                  noshow_fee_percent: 20,
                  noshow_group_whole_party: true,
                  noshow_deposit_escalation_threshold: null,
                  noshow_require_new_customer: false,
                  noshow_require_prior_noshow: false,
                  noshow_min_noshow_count: 1,
                  noshow_require_high_risk: false,
                  noshow_short_notice_hours: 24,
                }
              : null,
        }),
        in: async () => ({
          data: table === "services" ? [{ price_cents: 10_000 }] : [],
        }),
        limit: async () => ({
          // Clean returning customer: the short-notice rule must be the only
          // reason a card is requested.
          data: table === "bookings" ? [{ status: "completed" }] : [],
        }),
      };
      return chain;
    },
  }),
}));

import { resolveNoShowCardRequirement } from "@/shared/noshow/resolveNoShowCardRequirement";

const NOW = new Date("2026-08-08T12:00:00.000Z");

describe("pre-booking short-notice card requirement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires a 20% card hold for a clean returning customer inside 24h", async () => {
    await expect(
      resolveNoShowCardRequirement({
        salonId: "salon-test",
        serviceId: "service-test",
        clientPhone: "6045550111",
        appointmentStartUtc: "2026-08-08T14:00:00.000Z",
      }),
    ).resolves.toEqual({
      required: true,
      feeCents: 2_000,
      provider: "square",
      applicationId: "sq0idp_test",
      locationId: "location_test",
      environment: "sandbox",
    });
  });

  it("does not add friction outside the configured 24h window", async () => {
    await expect(
      resolveNoShowCardRequirement({
        salonId: "salon-test",
        serviceId: "service-test",
        clientPhone: "6045550111",
        appointmentStartUtc: "2026-08-09T12:00:00.001Z",
      }),
    ).resolves.toEqual({ required: false });
  });
});
