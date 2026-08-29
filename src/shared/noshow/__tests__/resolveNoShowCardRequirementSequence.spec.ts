import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  looseServiceClient: vi.fn(),
  resolvePaymentProvider: vi.fn(),
  getSquareConfig: vi.fn(),
  quotePublicBookingSequence: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: mocks.looseServiceClient,
}));
vi.mock("@/shared/release/v1IntegrationScope", () => ({
  v1AllowsNoShowCardOnFile: () => true,
}));
vi.mock("@/shared/integrations/payments", () => ({
  resolvePaymentProvider: mocks.resolvePaymentProvider,
}));
vi.mock("@/shared/integrations/square/client", () => ({
  getSquareConfig: mocks.getSquareConfig,
}));
vi.mock("@/shared/booking/bookingSequenceServer", () => ({
  quotePublicBookingSequence: mocks.quotePublicBookingSequence,
}));

import { resolveNoShowCardRequirement } from "@/shared/noshow/resolveNoShowCardRequirement";

const salonId = "11111111-1111-4111-8111-111111111111";
const serviceA = "22222222-2222-4222-8222-222222222222";
const serviceB = "33333333-3333-4333-8333-333333333333";

describe("sequence no-show card fee base", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePaymentProvider.mockResolvedValue({ kind: "square" });
    mocks.getSquareConfig.mockResolvedValue({
      applicationId: "sq-app",
      locationId: "sq-location",
      environment: "sandbox",
    });
    mocks.quotePublicBookingSequence.mockResolvedValue({
      ok: true,
      quote: {
        pricingFingerprint: "a".repeat(64),
        lines: [
          { servicePriceCents: 3_000 },
          { servicePriceCents: 2_000 },
          { servicePriceCents: 3_000 },
        ],
      },
    });
    mocks.looseServiceClient.mockReturnValue({
      from(table: string) {
        if (table === "salons") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    noshow_protection_enabled: true,
                    noshow_fee_percent: 20,
                    noshow_group_whole_party: true,
                    noshow_deposit_escalation_threshold: null,
                  },
                }),
              }),
            }),
          };
        }
        if (table === "bookings") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  not: () => ({ limit: async () => ({ data: [] }) }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    });
  });

  it("counts every sequence occurrence, including the same service twice", async () => {
    await expect(resolveNoShowCardRequirement({
      salonId,
      serviceId: serviceA,
      sequenceIntent: { ordered: [serviceA, serviceB, serviceA] },
      sequencePricingFingerprint: "a".repeat(64),
      clientPhone: "6045550101",
    })).resolves.toMatchObject({
      required: true,
      feeCents: 1_600,
      provider: "square",
    });
    expect(mocks.quotePublicBookingSequence).toHaveBeenCalledWith({
      ordered: [serviceA, serviceB, serviceA],
    });
  });

  it("fails open without exposing a stale fee when the quote fingerprint changed", async () => {
    await expect(resolveNoShowCardRequirement({
      salonId,
      serviceId: serviceA,
      sequenceIntent: { ordered: [serviceA, serviceB] },
      sequencePricingFingerprint: "b".repeat(64),
      clientPhone: "6045550101",
    })).resolves.toEqual({ required: false });
  });
});
