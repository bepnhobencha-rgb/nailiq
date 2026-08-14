import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  writeMaybeSingle: vi.fn(),
  readMaybeSingle: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      update: (patch: unknown) => {
        mocks.update(patch);
        return {
          eq: () => ({
            is: () => ({
              select: () => ({ maybeSingle: mocks.writeMaybeSingle }),
            }),
          }),
        };
      },
      select: () => ({
        eq: () => ({ maybeSingle: mocks.readMaybeSingle }),
      }),
    }),
  }),
}));

import { persistStripeCustomerBinding } from "@/shared/subscriptions/stripeCustomerBinding";

describe("persistStripeCustomerBinding", () => {
  beforeEach(() => {
    mocks.update.mockReset();
    mocks.writeMaybeSingle.mockReset();
    mocks.readMaybeSingle.mockReset();
  });

  it("wins the NULL-only compare-and-set", async () => {
    mocks.writeMaybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_one" },
      error: null,
    });

    await expect(
      persistStripeCustomerBinding({
        salonId: "salon-one",
        stripeCustomerId: "cus_one",
      }),
    ).resolves.toBeUndefined();

    expect(mocks.update).toHaveBeenCalledWith({
      stripe_customer_id: "cus_one",
    });
    expect(mocks.readMaybeSingle).not.toHaveBeenCalled();
  });

  it("accepts a zero-row race only when the winner stored the same customer", async () => {
    mocks.writeMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.readMaybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_same" },
      error: null,
    });

    await expect(
      persistStripeCustomerBinding({
        salonId: "salon-one",
        stripeCustomerId: "cus_same",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when a concurrent worker bound a different customer", async () => {
    mocks.writeMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.readMaybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_other" },
      error: null,
    });

    await expect(
      persistStripeCustomerBinding({
        salonId: "salon-one",
        stripeCustomerId: "cus_expected",
      }),
    ).rejects.toThrow("stripe_customer_binding_conflict");
  });
});
