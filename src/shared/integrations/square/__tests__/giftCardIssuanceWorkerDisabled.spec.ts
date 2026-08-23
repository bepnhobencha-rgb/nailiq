import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { dispatchSquareGiftCardIssuanceOperation } from "../giftCardIssuanceWorker";

describe("Square Gift Card issuance application gate", () => {
  it("returns before DB and provider dispatch while the contract is hard OFF", async () => {
    const rpc = vi.fn();
    const createGiftCard = vi.fn();
    await expect(dispatchSquareGiftCardIssuanceOperation({
      operationKind: "gift_card_create",
      salonId: "11111111-1111-4111-8111-111111111111",
      requestId: "22222222-2222-4222-8222-222222222222",
      expectedEnvironment: "sandbox",
      sourceId: "issuance-intent-1",
    }, {
      db: { rpc } as never,
      createGiftCard,
    })).resolves.toEqual({
      status: "disabled",
      reason: "app_contract_unavailable",
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(createGiftCard).not.toHaveBeenCalled();
  });
});
