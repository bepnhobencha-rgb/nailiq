import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  SQUARE_OPTIONAL_CAPABILITY_LIMITS,
} from "@/shared/integrations/square/optionalCapabilities";

export const MAX_SQUARE_WEBHOOK_BYTES = 256 * 1024;

export type SquareWebhookProfile = {
  applicationId: string;
  environment: "sandbox" | "production";
  notificationUrl: string;
  signatureKey: string;
};

export type ParsedSquareEvent = {
  eventId: string;
  eventType: string;
  merchantId: string;
  occurredAt: string;
  dataId: string | null;
  object: Record<string, unknown>;
};

const OPTIONAL_EVENTS = new Set<string>([
  ...SQUARE_OPTIONAL_CAPABILITY_LIMITS.loyalty.reconciliationEvents,
  ...SQUARE_OPTIONAL_CAPABILITY_LIMITS.gift_cards.reconciliationEvents,
  ...SQUARE_OPTIONAL_CAPABILITY_LIMITS.inventory.reconciliationEvents,
]);
const TEXT_RE = /^[^\u0000-\u001f\u007f]{1,255}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown): string | null {
  return typeof value === "string" && TEXT_RE.test(value) ? value : null;
}

function optionalText(value: unknown): string | null {
  if (value == null) return null;
  return boundedText(value);
}

function boundedInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) ? (value as number) : null;
}

function money(value: unknown): { amount: number; currency: string } | null {
  const row = asRecord(value);
  const amount = boundedInteger(row?.amount);
  const currency = typeof row?.currency === "string" && /^[A-Z]{3}$/.test(row.currency)
    ? row.currency
    : null;
  return amount !== null && currency ? { amount, currency } : null;
}

export function resolveSquareWebhookProfile(
  notificationUrl: string,
  rawConfig = process.env.SQUARE_WEBHOOK_PROFILES_JSON,
): SquareWebhookProfile | null {
  if (!rawConfig || rawConfig.length > 65_536) return null;
  try {
    const parsed: unknown = JSON.parse(rawConfig);
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) return null;
    const profiles: SquareWebhookProfile[] = [];
    for (const value of parsed) {
      const row = asRecord(value);
      const applicationId = boundedText(row?.applicationId);
      const environment = row?.environment;
      const configuredUrl = typeof row?.notificationUrl === "string"
        ? row.notificationUrl
        : "";
      const signatureKey = typeof row?.signatureKey === "string"
        ? row.signatureKey
        : "";
      let url: URL;
      try {
        url = new URL(configuredUrl);
      } catch {
        return null;
      }
      if (
        !applicationId ||
        (environment !== "sandbox" && environment !== "production") ||
        url.protocol !== "https:" ||
        configuredUrl !== url.toString() ||
        signatureKey.length < 16 ||
        signatureKey.length > 512
      ) {
        return null;
      }
      profiles.push({ applicationId, environment, notificationUrl: configuredUrl, signatureKey });
    }
    if (new Set(profiles.map((profile) => profile.notificationUrl)).size !== profiles.length) {
      return null;
    }
    return profiles.find((profile) => profile.notificationUrl === notificationUrl) ?? null;
  } catch {
    return null;
  }
}

export async function readSquareWebhookBody(
  request: Request,
): Promise<{ ok: true; bytes: Uint8Array; text: string } | { ok: false; code: string }> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SQUARE_WEBHOOK_BYTES) {
      return { ok: false, code: "body_too_large" };
    }
  }
  if (!request.body) return { ok: false, code: "invalid_body" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SQUARE_WEBHOOK_BYTES) {
        await reader.cancel();
        return { ok: false, code: "body_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: "invalid_body" };
  }
  if (total === 0) return { ok: false, code: "invalid_body" };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, bytes, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, code: "invalid_body" };
  }
}

export function verifySquareWebhookSignature(input: {
  profile: SquareWebhookProfile;
  body: Uint8Array;
  signatureHeader: string | null;
}): boolean {
  const header = input.signatureHeader?.trim() ?? "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(header)) return false;
  try {
    const expected = createHmac("sha256", input.profile.signatureKey)
      .update(input.profile.notificationUrl, "utf8")
      .update(input.body)
      .digest();
    const actual = Buffer.from(header, "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function squareWebhookPayloadFingerprint(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function parseSquareEvent(raw: string): ParsedSquareEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const row = asRecord(value);
  const data = asRecord(row?.data);
  const object = asRecord(data?.object);
  const eventId = boundedText(row?.event_id);
  const eventType = boundedText(row?.type);
  const merchantId = boundedText(row?.merchant_id);
  const occurredAt = typeof row?.created_at === "string" && RFC3339_RE.test(row.created_at)
    && Number.isFinite(Date.parse(row.created_at))
    ? row.created_at
    : null;
  if (!row || !data || !object || !eventId || !eventType || !merchantId || !occurredAt) {
    return null;
  }
  return {
    eventId,
    eventType,
    merchantId,
    occurredAt,
    dataId: optionalText(data.id),
    object,
  };
}

export function isSquareOptionalWebhookEvent(eventType: string): boolean {
  return OPTIONAL_EVENTS.has(eventType);
}

function projectEntity(
  entity: Record<string, unknown>,
  stringKeys: readonly string[],
  integerKeys: readonly string[],
) {
  const projected: Record<string, unknown> = {};
  for (const key of stringKeys) {
    const value = optionalText(entity[key]);
    if (value !== null) projected[key] = value;
  }
  for (const key of integerKeys) {
    const value = boundedInteger(entity[key]);
    if (value !== null) projected[key] = value;
  }
  for (const key of ["amount_money", "balance_money"] as const) {
    const value = money(entity[key]);
    if (value) projected[key] = value;
  }
  return projected;
}

export function sanitizeSquareOptionalEvent(
  event: ParsedSquareEvent,
): { entityId: string; material: Record<string, unknown> } | null {
  const type = event.eventType;
  if (!OPTIONAL_EVENTS.has(type)) return null;

  if (type === "inventory.count.updated") {
    const values = event.object.inventory_counts;
    if (!Array.isArray(values) || values.length < 1 || values.length > 100) return null;
    const counts = values.map((value) => {
      const row = asRecord(value);
      const catalogObjectId = boundedText(row?.catalog_object_id);
      const catalogObjectType = row?.catalog_object_type;
      const locationId = boundedText(row?.location_id);
      const quantity = typeof row?.quantity === "string" && /^-?[0-9]{1,12}(?:\.[0-9]{1,5})?$/.test(row.quantity)
        ? row.quantity
        : null;
      const state = boundedText(row?.state);
      const calculatedAt = typeof row?.calculated_at === "string" && RFC3339_RE.test(row.calculated_at)
        && Number.isFinite(Date.parse(row.calculated_at))
        ? row.calculated_at
        : null;
      return row && catalogObjectId && catalogObjectType === "ITEM_VARIATION"
        && locationId && quantity && state && calculatedAt
        ? {
            catalog_object_id: catalogObjectId,
            catalog_object_type: catalogObjectType,
            location_id: locationId,
            quantity,
            state,
            calculated_at: calculatedAt,
          }
        : null;
    });
    if (counts.some((count) => count === null)) return null;
    return {
      entityId: event.dataId ?? (counts[0] as { catalog_object_id: string }).catalog_object_id,
      material: { counts },
    };
  }

  if (type === "catalog.version.updated") {
    const catalog = asRecord(event.object.catalog_version);
    const updatedAt = typeof catalog?.updated_at === "string" && RFC3339_RE.test(catalog.updated_at)
      && Number.isFinite(Date.parse(catalog.updated_at))
      ? catalog.updated_at
      : null;
    if (!updatedAt) return null;
    return {
      entityId: event.dataId ?? event.merchantId,
      material: { catalog_updated_at: updatedAt },
    };
  }

  const key = type.startsWith("loyalty.account.") ? "loyalty_account"
    : type.startsWith("loyalty.program.") ? "loyalty_program"
      : type.startsWith("loyalty.promotion.") ? "loyalty_promotion"
        : type === "loyalty.event.created" ? "loyalty_event"
          : type.startsWith("gift_card.activity.") ? "gift_card_activity"
            : type.startsWith("gift_card.") ? "gift_card"
              : null;
  if (!key) return null;
  const entity = asRecord(event.object[key]);
  const entityId = event.dataId ?? boundedText(entity?.id);
  if (!entity || !entityId) return null;
  const projected = projectEntity(
    entity,
    [
      "id", "program_id", "loyalty_account_id", "type", "status", "state",
      "location_id", "created_at", "updated_at", "enrolled_at",
    ],
    ["balance", "lifetime_points", "points"],
  );
  projected.id = entityId;
  return { entityId, material: { entity: projected } };
}
