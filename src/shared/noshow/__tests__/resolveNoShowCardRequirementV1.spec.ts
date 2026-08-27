import { beforeEach, describe, expect, it, vi } from "vitest";

const { looseServiceClient, resolvePaymentProvider, getSquareConfig } = vi.hoisted(
  () => ({
    looseServiceClient: vi.fn(),
    resolvePaymentProvider: vi.fn(),
    getSquareConfig: vi.fn(),
  }),
);

vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient,
}));
vi.mock("@/shared/release/v1IntegrationScope", () => ({
  v1AllowsNoShowCardOnFile: () => false,
}));

vi.mock("@/shared/integrations/payments", () => ({
  resolvePaymentProvider,
}));

vi.mock("@/shared/integrations/square/client", () => ({
  getSquareConfig,
}));

import { resolveNoShowCardRequirement } from "@/shared/noshow/resolveNoShowCardRequirement";

describe("disabled pre-booking card requirement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not required before database or provider work", async () => {
    const result = await resolveNoShowCardRequirement({
      salonId: "11111111-1111-4111-8111-111111111111",
      serviceId: "22222222-2222-4222-8222-222222222222",
      clientPhone: "6045550101",
    });

    expect(result).toEqual({ required: false });
    expect(looseServiceClient).not.toHaveBeenCalled();
    expect(resolvePaymentProvider).not.toHaveBeenCalled();
    expect(getSquareConfig).not.toHaveBeenCalled();
  });
});
