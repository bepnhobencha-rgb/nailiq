import { describe, expect, it, vi } from "vitest";

const from = vi.fn(() => {
  throw new Error("database must not be reached while value mutations are off");
});

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from }),
}));
vi.mock("@/shared/dashboard/salonOwnerActions", () => ({
  resolveSalonForDashboard: vi.fn(() => {
    throw new Error("authorization lookup must not be reached while hard off");
  }),
}));
vi.mock("@/shared/features/platformFeatureFlags", () => ({
  isReleaseFeatureVisible: vi.fn(),
}));

import {
  addStampsManually,
  getClientLoyaltyCardByPhone,
  issueLoyaltyVoucherIfEarned,
  redeemReward,
} from "../loyaltyActions";
import { LOYALTY_VALUE_MUTATIONS_ENABLED } from "../loyaltyRuntimeConfig";
import {
  createGiftCard,
  getGiftCard,
  redeemGiftCard,
} from "../giftCardActions";
import { GIFT_CARD_VALUE_MUTATIONS_ENABLED } from "../giftCardConfig";

describe("unproven loyalty and gift value movement", () => {
  it("keeps all non-atomic value mutations hard off", async () => {
    expect(LOYALTY_VALUE_MUTATIONS_ENABLED).toBe(false);
    expect(GIFT_CARD_VALUE_MUTATIONS_ENABLED).toBe(false);

    await expect(addStampsManually("salon", "+16045550123", 1)).resolves.toEqual({
      ok: false,
      error: "loyalty_mutation_unavailable",
    });
    await expect(redeemReward("salon", "+16045550123")).resolves.toEqual({
      ok: false,
      error: "loyalty_mutation_unavailable",
    });
    await expect(
      issueLoyaltyVoucherIfEarned(
        "11111111-1111-4111-8111-111111111111",
        "+16045550123",
      ),
    ).resolves.toEqual({ issued: false });
    await expect(
      createGiftCard("salon", { valueCents: 5_000 }),
    ).resolves.toEqual({
      ok: false,
      error: "gift_card_issuance_unavailable",
    });
    await expect(redeemGiftCard("salon", "GFT-1234ABCD")).resolves.toEqual({
      ok: false,
      error: "gift_card_redemption_unavailable",
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("does not expose a loyalty balance from naked salon and phone input", async () => {
    await expect(
      getClientLoyaltyCardByPhone(
        "11111111-1111-4111-8111-111111111111",
        "+16045550123",
      ),
    ).resolves.toEqual({ card: null, program: null });
    expect(from).not.toHaveBeenCalled();
  });

  it("does not expose a gift-card row from a naked bearer code", async () => {
    await expect(getGiftCard("GFT-1234ABCD")).resolves.toBeNull();
    expect(from).not.toHaveBeenCalled();
  });
});
