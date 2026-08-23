import "server-only";

type JsonRecord = Record<string, unknown>;

export type SquareInventoryCatalogVariationMaterial = {
  id: string;
  item_id: string;
  version: string;
  product_type: "REGULAR";
  item_name: string;
  variation_name: string;
  sku?: string;
  is_deleted: boolean;
  track_inventory: boolean;
  present_at_bound_location: boolean;
  updated_at: string;
};

export type SquareInventoryCatalogPage = {
  latestTime: string;
  cursor: string | null;
  variations: SquareInventoryCatalogVariationMaterial[];
};

const TEXT_RE = /^[^\u0000-\u001f\u007f]{1,255}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown, max = 255): string | null {
  return typeof value === "string" && value.length <= max && TEXT_RE.test(value)
    ? value
    : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && RFC3339_RE.test(value)
    && Number.isFinite(Date.parse(value)) ? value : null;
}

function ids(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500) return null;
  const output = value.map((entry) => text(entry));
  return output.every((entry): entry is string => entry !== null) ? output : null;
}

function objectPresentAtLocation(object: JsonRecord, locationId: string): boolean | null {
  const all = object.present_at_all_locations;
  if (all !== undefined && typeof all !== "boolean") return null;
  const present = ids(object.present_at_location_ids);
  const absent = ids(object.absent_at_location_ids);
  if (!present || !absent) return null;
  const presentEverywhere = all === undefined ? true : all;
  return presentEverywhere ? !absent.includes(locationId) : present.includes(locationId);
}

function providerVersion(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[0-9]{1,19}$/.test(value)) return value;
  return null;
}

function boundTrackInventory(variationData: JsonRecord, locationId: string): boolean | null {
  const global = variationData.track_inventory;
  if (global !== undefined && typeof global !== "boolean") return null;
  const overrides = variationData.location_overrides;
  if (overrides !== undefined && !Array.isArray(overrides)) return null;
  let result = global === true;
  for (const value of overrides ?? []) {
    const override = record(value);
    const overrideLocation = text(override?.location_id);
    if (!override || !overrideLocation) return null;
    if (override.track_inventory !== undefined && typeof override.track_inventory !== "boolean") {
      return null;
    }
    if (overrideLocation === locationId && typeof override.track_inventory === "boolean") {
      result = override.track_inventory;
    }
  }
  return result;
}

export function buildSquareInventoryCatalogSearchRequest(input: {
  latestTime: string | null;
  cursor: string | null;
}): Record<string, unknown> | null {
  if (input.latestTime !== null && !timestamp(input.latestTime)) return null;
  if (input.cursor !== null && !text(input.cursor, 2048)) return null;
  return {
    object_types: ["ITEM", "ITEM_VARIATION"],
    include_deleted_objects: true,
    include_related_objects: true,
    ...(input.latestTime ? { begin_time: input.latestTime } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
}

export function sanitizeSquareInventoryCatalogPage(
  raw: unknown,
  boundLocationId: string,
): SquareInventoryCatalogPage | null {
  if (!text(boundLocationId)) return null;
  const response = record(raw);
  const latestTime = timestamp(response?.latest_time);
  const cursor = response?.cursor == null ? null : text(response.cursor, 2048);
  const objects = response?.objects;
  const related = response?.related_objects;
  if (!response || !latestTime || cursor === null && response.cursor != null
      || !Array.isArray(objects) || objects.length > 1000
      || related !== undefined && (!Array.isArray(related) || related.length > 1000)) {
    return null;
  }

  const allObjects = [...objects, ...(Array.isArray(related) ? related : [])];
  const items = new Map<string, JsonRecord>();
  for (const value of allObjects) {
    const object = record(value);
    if (!object) return null;
    if (object.type === "ITEM") {
      const id = text(object.id);
      const itemData = record(object.item_data);
      if (!id || !itemData) return null;
      items.set(id, object);
    }
  }

  const variationObjects: JsonRecord[] = [];
  for (const value of objects) {
    const object = record(value);
    if (!object) return null;
    if (object.type === "ITEM_VARIATION") variationObjects.push(object);
    if (object.type === "ITEM") {
      const itemData = record(object.item_data);
      if (!Array.isArray(itemData?.variations)) continue;
      for (const variation of itemData.variations) {
        const variationObject = record(variation);
        if (!variationObject || variationObject.type !== "ITEM_VARIATION") return null;
        variationObjects.push(variationObject);
      }
    }
  }

  const normalized = new Map<string, SquareInventoryCatalogVariationMaterial>();
  for (const object of variationObjects) {
    const variationData = record(object.item_variation_data);
    const id = text(object.id);
    const itemId = text(variationData?.item_id);
    const item = itemId ? items.get(itemId) : null;
    const itemData = record(item?.item_data);
    if (!id || !itemId || !variationData || !item || !itemData) return null;
    if (itemData.product_type !== "REGULAR") continue;

    const itemName = text(itemData.name, 500);
    const variationName = text(variationData.name, 500);
    const version = providerVersion(object.version);
    const updatedAt = timestamp(object.updated_at);
    const itemPresent = objectPresentAtLocation(item, boundLocationId);
    const variationPresent = objectPresentAtLocation(object, boundLocationId);
    const trackInventory = boundTrackInventory(variationData, boundLocationId);
    const sku = variationData.sku == null ? undefined : text(variationData.sku);
    if (!itemName || !variationName || !version || !updatedAt
        || itemPresent === null || variationPresent === null || trackInventory === null
        || sku === null || object.is_deleted !== undefined && typeof object.is_deleted !== "boolean") {
      return null;
    }
    const material: SquareInventoryCatalogVariationMaterial = {
      id,
      item_id: itemId,
      version,
      product_type: "REGULAR",
      item_name: itemName,
      variation_name: variationName,
      ...(sku ? { sku } : {}),
      is_deleted: object.is_deleted === true,
      track_inventory: trackInventory,
      present_at_bound_location: itemPresent && variationPresent,
      updated_at: updatedAt,
    };
    const prior = normalized.get(id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(material)) return null;
    normalized.set(id, material);
  }
  // A valid incremental search can contain no changed retail variations. It
  // still carries Square's latest_time and must advance the durable cursor.
  if (normalized.size > 100) return null;
  return { latestTime, cursor, variations: [...normalized.values()] };
}
