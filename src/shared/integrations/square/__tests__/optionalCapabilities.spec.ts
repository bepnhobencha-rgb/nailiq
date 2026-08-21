import { describe, expect, it } from "vitest";
import {
  SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE,
  SQUARE_OPTIONAL_CAPABILITY_LIMITS,
  evaluateSquareOptionalCapability,
  type SquareOptionalCapability,
} from "../optionalCapabilities";

const SALON_ID = "11111111-1111-4111-8111-111111111111";

function material(
  capability: SquareOptionalCapability,
  overrides: Record<string, unknown> = {},
) {
  return {
    contract_version: 1,
    provider: "square",
    salon_id: SALON_ID,
    application_id: "sandbox-sq0idb-application-1",
    merchant_id: "merchant-1",
    location_id: "location-1",
    environment: "sandbox",
    api_version: "2026-07-15",
    provider_account_fingerprint: "a".repeat(64),
    enabled: true,
    capabilities: {
      loyalty: capability === "loyalty",
      gift_cards: capability === "gift_cards",
      inventory: capability === "inventory",
    },
    granted_scopes: {
      loyalty: ["LOYALTY_READ", "LOYALTY_WRITE"],
      gift_cards: ["GIFTCARDS_READ", "GIFTCARDS_WRITE", "PAYMENTS_WRITE"],
      inventory: ["ITEMS_READ", "INVENTORY_READ", "INVENTORY_WRITE"],
    }[capability],
    ...overrides,
  };
}

describe("Square optional capability readiness", () => {
  it("keeps every unproven app contract hard off", () => {
    expect(SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE).toEqual({
      loyalty: false,
      gift_cards: false,
      inventory: false,
    });

    for (const capability of [
      "loyalty",
      "gift_cards",
      "inventory",
    ] as const) {
      expect(evaluateSquareOptionalCapability(capability, material(capability))).toEqual({
        ready: false,
        capability,
        reason: "app_contract_unavailable",
      });
    }
  });

  it("declares the provider reconciliation surface without claiming support", () => {
    expect(SQUARE_OPTIONAL_CAPABILITY_LIMITS.loyalty).toMatchObject({
      programConfiguration: "square_dashboard_only",
      reconciliationEvents: expect.arrayContaining([
        "loyalty.program.created",
        "loyalty.program.updated",
        "loyalty.promotion.created",
        "loyalty.promotion.updated",
        "loyalty.account.created",
        "loyalty.account.deleted",
        "loyalty.account.updated",
        "loyalty.event.created",
      ]),
    });
    expect(SQUARE_OPTIONAL_CAPABILITY_LIMITS.gift_cards).toMatchObject({
      activationRequiredAfterPayment: true,
      reconciliationEvents: expect.arrayContaining([
        "gift_card.created",
        "gift_card.updated",
        "gift_card.customer_linked",
        "gift_card.customer_unlinked",
        "gift_card.activity.created",
        "gift_card.activity.updated",
      ]),
    });
    expect(SQUARE_OPTIONAL_CAPABILITY_LIMITS.inventory).toMatchObject({
      inventoryUnit: "catalog_item_variation",
      ingredientsAndBundlesSupported: false,
      reconciliationEvents: expect.arrayContaining([
        "catalog.version.updated",
        "inventory.count.updated",
      ]),
    });
  });

  it("does not infer production from an unknown or missing environment", () => {
    expect(
      evaluateSquareOptionalCapability(
        "inventory",
        material("inventory", { environment: "live" }),
      ),
    ).toMatchObject({ ready: false, reason: "invalid_material" });
    expect(
      evaluateSquareOptionalCapability(
        "inventory",
        material("inventory", { environment: undefined }),
      ),
    ).toMatchObject({ ready: false, reason: "invalid_material" });
  });

  it("rejects a missing or legacy API version instead of inheriting booking sync", () => {
    expect(
      evaluateSquareOptionalCapability(
        "loyalty",
        material("loyalty", { api_version: undefined }),
      ),
    ).toMatchObject({ ready: false, reason: "invalid_material" });
    expect(
      evaluateSquareOptionalCapability(
        "loyalty",
        material("loyalty", { api_version: "2024-12-18" }),
      ),
    ).toMatchObject({ ready: false, reason: "invalid_material" });
  });

  it("requires the exact provider scopes for each product", () => {
    expect(
      evaluateSquareOptionalCapability(
        "gift_cards",
        material("gift_cards", {
          granted_scopes: ["GIFTCARDS_READ", "GIFTCARDS_WRITE"],
        }),
      ),
    ).toEqual({
      ready: false,
      capability: "gift_cards",
      reason: "missing_scopes",
      missingScopes: ["PAYMENTS_WRITE"],
    });
    expect(
      evaluateSquareOptionalCapability(
        "inventory",
        material("inventory", {
          granted_scopes: ["INVENTORY_READ", "INVENTORY_WRITE"],
        }),
      ),
    ).toEqual({
      ready: false,
      capability: "inventory",
      reason: "missing_scopes",
      missingScopes: ["ITEMS_READ"],
    });
  });

  it("fails closed on disabled capability or malformed tenant binding", () => {
    expect(
      evaluateSquareOptionalCapability(
        "loyalty",
        material("loyalty", { enabled: false }),
      ),
    ).toMatchObject({ ready: false, reason: "integration_disabled" });
    expect(
      evaluateSquareOptionalCapability("loyalty", {
        ...material("loyalty"),
        capabilities: { loyalty: false, gift_cards: false, inventory: false },
      }),
    ).toMatchObject({ ready: false, reason: "capability_disabled" });
    expect(
      evaluateSquareOptionalCapability(
        "loyalty",
        material("loyalty", { salon_id: "not-a-uuid" }),
      ),
    ).toMatchObject({ ready: false, reason: "invalid_material" });
    expect(
      evaluateSquareOptionalCapability(
        "loyalty",
        material("loyalty", { application_id: undefined }),
      ),
    ).toMatchObject({ ready: false, reason: "invalid_material" });
  });
});
