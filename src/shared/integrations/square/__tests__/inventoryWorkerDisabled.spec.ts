import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  reconcileStaleSquareInventoryCatalogOperations,
  syncSquareInventoryCatalogForSalon,
} from "../inventoryWorker";

describe("Square Inventory worker default-off boundary", () => {
  it("returns before DB construction or provider dispatch", async () => {
    const searchCatalog = vi.fn();
    await expect(syncSquareInventoryCatalogForSalon(
      "11111111-1111-4111-8111-111111111111",
      { searchCatalog },
    )).resolves.toEqual({
      status: "disabled",
      reason: "app_contract_unavailable",
    });
    await expect(reconcileStaleSquareInventoryCatalogOperations({ searchCatalog }))
      .resolves.toEqual([{
        status: "disabled",
        reason: "app_contract_unavailable",
      }]);
    expect(searchCatalog).not.toHaveBeenCalled();
  });
});
