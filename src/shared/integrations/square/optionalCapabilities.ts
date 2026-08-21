/**
 * Square Loyalty, Gift Cards, and Inventory are separate provider products.
 * They must never inherit readiness from the existing booking/payment
 * connection. This module is deliberately provider-call-free: it only parses
 * tenant-bound material and applies app implementation gates.
 */

export const SQUARE_OPTIONAL_CAPABILITIES = [
  "loyalty",
  "gift_cards",
  "inventory",
] as const;

export type SquareOptionalCapability =
  (typeof SQUARE_OPTIONAL_CAPABILITIES)[number];

/** Explicit compatibility pin validated for the optional-product contracts.
 * Square's later 2026-08-19 release is intentionally NOT adopted here: this
 * 2026-07-15 contract must be revalidated in sandbox before any upgrade. Never
 * inherit the legacy booking-sync transport version. */
export const SQUARE_OPTIONAL_API_VERSION = "2026-07-15" as const;

export type SquareOptionalCapabilityReason =
  | "invalid_material"
  | "integration_disabled"
  | "capability_disabled"
  | "missing_scopes"
  | "app_contract_unavailable";

export type SquareOptionalCapabilityReadiness =
  | {
      ready: true;
      capability: SquareOptionalCapability;
      salonId: string;
      environment: "sandbox" | "production";
      apiVersion: typeof SQUARE_OPTIONAL_API_VERSION;
      providerAccountFingerprint: string;
    }
  | {
      ready: false;
      capability: SquareOptionalCapability;
      reason: SquareOptionalCapabilityReason;
      missingScopes?: string[];
    };

type ParsedMaterial = {
  salonId: string;
  environment: "sandbox" | "production";
  apiVersion: typeof SQUARE_OPTIONAL_API_VERSION;
  providerAccountFingerprint: string;
  enabled: boolean;
  capabilities: Record<SquareOptionalCapability, boolean>;
  grantedScopes: Set<string>;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

const REQUIRED_SCOPES: Record<SquareOptionalCapability, readonly string[]> = {
  loyalty: ["LOYALTY_READ", "LOYALTY_WRITE"],
  // The locked gift-card chain creates the corresponding Square Payment
  // before activation, so readiness also needs PAYMENTS_WRITE.
  gift_cards: ["GIFTCARDS_READ", "GIFTCARDS_WRITE", "PAYMENTS_WRITE"],
  // Inventory quantities refer to CatalogItemVariation ids, so item mapping is
  // impossible to reconcile safely without ITEMS_READ as well.
  inventory: ["ITEMS_READ", "INVENTORY_READ", "INVENTORY_WRITE"],
};

export const SQUARE_OPTIONAL_CAPABILITY_LIMITS = Object.freeze({
  loyalty: {
    programConfiguration: "square_dashboard_only",
    reconciliationEvents: [
      "loyalty.program.created",
      "loyalty.program.updated",
      "loyalty.promotion.created",
      "loyalty.promotion.updated",
      "loyalty.account.created",
      "loyalty.account.deleted",
      "loyalty.account.updated",
      "loyalty.event.created",
    ],
  },
  gift_cards: {
    activationRequiredAfterPayment: true,
    reconciliationEvents: [
      "gift_card.created",
      "gift_card.updated",
      "gift_card.customer_linked",
      "gift_card.customer_unlinked",
      "gift_card.activity.created",
      "gift_card.activity.updated",
    ],
  },
  inventory: {
    inventoryUnit: "catalog_item_variation",
    ingredientsAndBundlesSupported: false,
    reconciliationEvents: ["catalog.version.updated", "inventory.count.updated"],
  },
} as const);

/**
 * These stay hard OFF until the app has a tenant-bound durable operation,
 * webhook/cursor reconciliation, and executable sandbox receipt evidence.
 */
export const SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE: Readonly<
  Record<SquareOptionalCapability, boolean>
> = Object.freeze({
  loyalty: false,
  gift_cards: false,
  inventory: false,
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseMaterial(value: unknown): ParsedMaterial | null {
  const row = asRecord(value);
  const caps = asRecord(row?.capabilities);
  if (!row || !caps || row.contract_version !== 1 || row.provider !== "square") {
    return null;
  }

  const salonId = row.salon_id;
  const environment = row.environment;
  const apiVersion = row.api_version;
  const fingerprint = row.provider_account_fingerprint;
  const merchantId = row.merchant_id;
  const locationId = row.location_id;
  const applicationId = row.application_id;
  const scopes = row.granted_scopes;
  if (
    typeof salonId !== "string" ||
    !UUID_RE.test(salonId) ||
    (environment !== "sandbox" && environment !== "production") ||
    apiVersion !== SQUARE_OPTIONAL_API_VERSION ||
    typeof fingerprint !== "string" ||
    !SHA256_RE.test(fingerprint) ||
    typeof merchantId !== "string" ||
    merchantId.trim() === "" ||
    typeof locationId !== "string" ||
    locationId.trim() === "" ||
    typeof applicationId !== "string" ||
    applicationId.trim() === "" ||
    typeof row.enabled !== "boolean" ||
    !Array.isArray(scopes) ||
    scopes.some((scope) => typeof scope !== "string") ||
    SQUARE_OPTIONAL_CAPABILITIES.some(
      (capability) => typeof caps[capability] !== "boolean",
    )
  ) {
    return null;
  }

  return {
    salonId,
    environment,
    apiVersion,
    providerAccountFingerprint: fingerprint,
    enabled: row.enabled,
    capabilities: {
      loyalty: caps.loyalty as boolean,
      gift_cards: caps.gift_cards as boolean,
      inventory: caps.inventory as boolean,
    },
    grantedScopes: new Set(scopes as string[]),
  };
}

export function evaluateSquareOptionalCapability(
  capability: SquareOptionalCapability,
  material: unknown,
): SquareOptionalCapabilityReadiness {
  const parsed = parseMaterial(material);
  if (!parsed) return { ready: false, capability, reason: "invalid_material" };
  if (!parsed.enabled) {
    return { ready: false, capability, reason: "integration_disabled" };
  }
  if (!parsed.capabilities[capability]) {
    return { ready: false, capability, reason: "capability_disabled" };
  }

  const missingScopes = REQUIRED_SCOPES[capability].filter(
    (scope) => !parsed.grantedScopes.has(scope),
  );
  if (missingScopes.length > 0) {
    return {
      ready: false,
      capability,
      reason: "missing_scopes",
      missingScopes,
    };
  }

  if (!SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE[capability]) {
    return { ready: false, capability, reason: "app_contract_unavailable" };
  }

  return {
    ready: true,
    capability,
    salonId: parsed.salonId,
    environment: parsed.environment,
    apiVersion: parsed.apiVersion,
    providerAccountFingerprint: parsed.providerAccountFingerprint,
  };
}
