import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("POST /api/gift-card/purchase", () => {
  it("is permanently unavailable until a paid Square issuance route replaces it", async () => {
    const response = await POST();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "gift_cards_unavailable" });
  });
});
