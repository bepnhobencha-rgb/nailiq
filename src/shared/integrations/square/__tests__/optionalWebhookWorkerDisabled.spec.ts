import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { processSquareOptionalWebhookInbox } from "../optionalWebhookWorker";

describe("Square optional webhook workers default-off boundary", () => {
  it("returns before DB construction for every optional capability", async () => {
    await expect(processSquareOptionalWebhookInbox("loyalty"))
      .resolves.toEqual([{ status: "disabled", capability: "loyalty" }]);
    await expect(processSquareOptionalWebhookInbox("gift_cards"))
      .resolves.toEqual([{ status: "disabled", capability: "gift_cards" }]);
    await expect(processSquareOptionalWebhookInbox("inventory"))
      .resolves.toEqual([{ status: "disabled", capability: "inventory" }]);
  });
});
