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

  if (type.startsWith("loyalty.account.")) {
    const entity = asRecord(event.object.loyalty_account);
    const entityId = event.dataId ?? boundedText(entity?.id);
    if (!entity || !entityId) return null;
    if (type === "loyalty.account.deleted") {
      return { entityId, material: { entity: { id: entityId } } };
    }
    const programId = boundedText(entity.program_id);
    const balance = boundedInteger(entity.balance);
    const lifetimePoints = boundedInteger(entity.lifetime_points);
    const updatedAt = typeof entity.updated_at === "string"
      && RFC3339_RE.test(entity.updated_at)
      && Number.isFinite(Date.parse(entity.updated_at))
      ? entity.updated_at
      : null;
    if (
      !programId || balance === null || balance < 0
      || lifetimePoints === null || lifetimePoints < 0 || !updatedAt
    ) return null;
    return {
      entityId,
      material: {
        entity: {
          id: entityId,
          program_id: programId,
          balance,
          lifetime_points: lifetimePoints,
          updated_at: updatedAt,
        },
      },
    };
  }

  if (type === "loyalty.event.created") {
    const entity = asRecord(event.object.loyalty_event);
    const entityId = event.dataId ?? boundedText(entity?.id);
    const eventType = boundedText(entity?.type);
    const accountId = boundedText(entity?.loyalty_account_id);
    const createdAt = typeof entity?.created_at === "string"
      && RFC3339_RE.test(entity.created_at)
      && Number.isFinite(Date.parse(entity.created_at))
      ? entity.created_at
      : null;
    const metadataKey = eventType === "ACCUMULATE_POINTS" ? "accumulate_points"
      : eventType === "ACCUMULATE_PROMOTION_POINTS" ? "accumulate_promotion_points"
        : eventType === "CREATE_REWARD" ? "create_reward"
          : eventType === "REDEEM_REWARD" ? "redeem_reward"
            : eventType === "DELETE_REWARD" ? "delete_reward"
              : eventType === "ADJUST_POINTS" ? "adjust_points"
                : eventType === "EXPIRE_POINTS" ? "expire_points"
                  : eventType === "OTHER" ? "other_event"
                    : null;
    const metadata = metadataKey ? asRecord(entity?.[metadataKey]) : null;
    const programId = boundedText(metadata?.loyalty_program_id);
    const points = boundedInteger(metadata?.points);
    const rewardId = optionalText(metadata?.reward_id);
    if (
      !entity || !entityId || !eventType || !accountId || !createdAt
      || !metadataKey || !metadata || !programId
      || (eventType !== "REDEEM_REWARD" && (points === null || points === 0))
      || (eventType === "REDEEM_REWARD" && points !== null)
      || (["CREATE_REWARD", "REDEEM_REWARD", "DELETE_REWARD"].includes(eventType)
        && !rewardId)
    ) return null;
    const projected: Record<string, unknown> = {
      id: entityId,
      type: eventType,
      loyalty_account_id: accountId,
      program_id: programId,
      created_at: createdAt,
    };
    const locationId = optionalText(entity.location_id);
    const source = optionalText(entity.source);
    const orderId = optionalText(metadata.order_id);
    if (eventType !== "REDEEM_REWARD") projected.points_delta = points;
    if (rewardId) projected.reward_id = rewardId;
    if (orderId) projected.order_id = orderId;
    if (locationId) projected.location_id = locationId;
    if (source) projected.source = source;
    return { entityId, material: { entity: projected } };
  }

  if (
    type === "gift_card.created" || type === "gift_card.updated"
    || type === "gift_card.customer_linked" || type === "gift_card.customer_unlinked"
  ) {
    const entity = asRecord(event.object.gift_card);
    const entityId = event.dataId ?? boundedText(entity?.id);
    const cardType = boundedText(entity?.type);
    const ganSource = boundedText(entity?.gan_source);
    const state = boundedText(entity?.state);
    const balance = money(entity?.balance_money);
    const createdAt = typeof entity?.created_at === "string"
      && RFC3339_RE.test(entity.created_at)
      && Number.isFinite(Date.parse(entity.created_at))
      ? entity.created_at
      : null;
    if (
      !entity || !entityId || !["PHYSICAL", "DIGITAL"].includes(cardType ?? "")
      || !["SQUARE", "OTHER"].includes(ganSource ?? "")
      || !["PENDING", "ACTIVE", "BLOCKED", "DEACTIVATED"].includes(state ?? "")
      || !balance || balance.amount < 0 || balance.amount > 200_000 || !createdAt
    ) return null;
    return {
      entityId,
      material: {
        entity: {
          id: entityId,
          type: cardType,
          gan_source: ganSource,
          state,
          balance_money: balance,
          created_at: createdAt,
        },
      },
    };
  }

  if (type === "gift_card.activity.created" || type === "gift_card.activity.updated") {
    const entity = asRecord(event.object.gift_card_activity);
    const entityId = event.dataId ?? boundedText(entity?.id);
    const activityType = boundedText(entity?.type);
    const locationId = boundedText(entity?.location_id);
    const giftCardId = boundedText(entity?.gift_card_id);
    const balance = money(entity?.gift_card_balance_money);
    const createdAt = typeof entity?.created_at === "string"
      && RFC3339_RE.test(entity.created_at)
      && Number.isFinite(Date.parse(entity.created_at))
      ? entity.created_at
      : null;
    const detailKey = activityType === "ACTIVATE" ? "activate_activity_details"
      : activityType === "LOAD" ? "load_activity_details"
        : activityType === "REDEEM" ? "redeem_activity_details"
          : activityType === "CLEAR_BALANCE" ? "clear_balance_activity_details"
            : activityType === "DEACTIVATE" ? "deactivate_activity_details"
              : activityType === "ADJUST_INCREMENT" ? "adjust_increment_activity_details"
                : activityType === "ADJUST_DECREMENT" ? "adjust_decrement_activity_details"
                  : activityType === "REFUND" ? "refund_activity_details"
                    : activityType === "UNLINKED_ACTIVITY_REFUND"
                      ? "unlinked_activity_refund_activity_details"
                      : activityType === "IMPORT" ? "import_activity_details"
                        : activityType === "BLOCK" ? "block_activity_details"
                          : activityType === "UNBLOCK" ? "unblock_activity_details"
                            : activityType === "IMPORT_REVERSAL" ? "import_reversal_activity_details"
                              : activityType === "TRANSFER_BALANCE_FROM"
                                ? "transfer_balance_from_activity_details"
                                : activityType === "TRANSFER_BALANCE_TO"
                                  ? "transfer_balance_to_activity_details"
                                  : null;
    const details = detailKey ? asRecord(entity?.[detailKey]) : null;
    const amount = money(details?.amount_money);
    const amountRequired = [
      "ACTIVATE", "LOAD", "REDEEM", "ADJUST_INCREMENT", "ADJUST_DECREMENT",
      "REFUND", "UNLINKED_ACTIVITY_REFUND",
    ].includes(activityType ?? "");
    if (
      !entity || !entityId || !activityType || !detailKey || !details
      || !locationId || !giftCardId || !balance || balance.amount < 0
      || balance.amount > 200_000 || !createdAt
      || (amountRequired && (!amount || amount.amount < 1 || amount.amount > 200_000))
      || (amount && (amount.amount < 1 || amount.amount > 200_000))
    ) return null;
    const projected: Record<string, unknown> = {
      id: entityId,
      type: activityType,
      location_id: locationId,
      created_at: createdAt,
      gift_card_id: giftCardId,
      gift_card_balance_money: balance,
    };
    if (amount) projected.amount_money = amount;
    for (const key of [
      "status", "order_id", "payment_id", "redeem_activity_id", "reference_id", "reason",
    ] as const) {
      const value = optionalText(details[key]);
      if (value) projected[key] = value;
    }
    return { entityId, material: { entity: projected } };
  }

  const key = type.startsWith("loyalty.program.") ? "loyalty_program"
      : type.startsWith("loyalty.promotion.") ? "loyalty_promotion"
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
