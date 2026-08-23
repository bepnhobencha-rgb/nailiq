import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../optionalCapabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../optionalCapabilities")>();
  return {
    ...actual,
    SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE: Object.freeze({
      loyalty: true,
      gift_cards: true,
      inventory: true,
    }),
  };
});

import type { LooseDb } from "../looseDb";
import { processSquareOptionalWebhookInbox } from "../optionalWebhookWorker";

const inboxId = "11111111-1111-4111-8111-111111111111";
const claimToken = "22222222-2222-4222-8222-222222222222";

function db(apply: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "claim_square_webhook_events") {
      return { data: [{ inbox_id: inboxId, claim_token: claimToken }], error: null };
    }
    if (name.startsWith("apply_square_")) return apply;
    if (name === "complete_square_webhook_event") {
      return { data: { success: true, code: "event_completed" }, error: null };
    }
    throw new Error(`unexpected RPC ${name}`);
  });
  return { client: { rpc } as unknown as LooseDb, rpc };
}

describe("Square optional webhook adoption worker", () => {
  it("claims and atomically applies a Loyalty inbox row", async () => {
    const database = db({
      data: { success: true, code: "loyalty_event_applied" },
      error: null,
    });
    await expect(processSquareOptionalWebhookInbox(
      "loyalty",
      { db: database.client },
    )).resolves.toEqual([{
      status: "applied",
      capability: "loyalty",
      inboxId,
      code: "loyalty_event_applied",
    }]);
    expect(database.rpc).toHaveBeenCalledWith("claim_square_webhook_events", {
      p_feature: "loyalty",
      p_limit: 25,
    });
    expect(database.rpc).toHaveBeenCalledWith("apply_square_loyalty_webhook_event", {
      p_inbox_id: inboxId,
      p_claim_token: claimToken,
    });
  });

  it("leaves an ambiguous apply under the durable lease for retry", async () => {
    const database = db({ data: null, error: { message: "response lost" } });
    await expect(processSquareOptionalWebhookInbox(
      "loyalty",
      { db: database.client },
    )).resolves.toEqual([{
      status: "retry_pending",
      capability: "loyalty",
      inboxId,
      reason: "inbox_apply_unavailable",
    }]);
    expect(database.rpc).not.toHaveBeenCalledWith(
      "complete_square_webhook_event",
      expect.anything(),
    );
  });

  it("durably fails poison material instead of retrying forever", async () => {
    const database = db({
      data: { success: false, code: "invalid_loyalty_material" },
      error: null,
    });
    await expect(processSquareOptionalWebhookInbox(
      "loyalty",
      { db: database.client },
    )).resolves.toEqual([{
      status: "failed",
      capability: "loyalty",
      inboxId,
      reason: "invalid_loyalty_material",
    }]);
    expect(database.rpc).toHaveBeenCalledWith(
      "complete_square_webhook_event",
      expect.objectContaining({
        p_status: "failed",
        p_error_code: "invalid_loyalty_material",
      }),
    );
  });

  it("routes Gift Card and Inventory to their own adoption RPCs", async () => {
    for (const [capability, fn] of [
      ["gift_cards", "apply_square_gift_card_webhook_event"],
      ["inventory", "apply_square_inventory_webhook_event"],
    ] as const) {
      const database = db({ data: { success: true, code: "event_applied" }, error: null });
      await processSquareOptionalWebhookInbox(capability, { db: database.client });
      expect(database.rpc).toHaveBeenCalledWith(fn, {
        p_inbox_id: inboxId,
        p_claim_token: claimToken,
      });
    }
  });
});
