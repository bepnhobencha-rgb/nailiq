import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildSquareInventoryCatalogSearchRequest,
  sanitizeSquareInventoryCatalogPage,
} from "../inventoryReconciliation";

const item = {
  type: "ITEM",
  id: "item-retail-polish",
  present_at_all_locations: true,
  item_data: {
    name: "Retail Polish",
    product_type: "REGULAR",
    variations: [{
      type: "ITEM_VARIATION",
      id: "variation-red",
      version: 1724346000000,
      updated_at: "2026-08-22T17:00:00Z",
      present_at_all_locations: true,
      item_variation_data: {
        item_id: "item-retail-polish",
        name: "Red",
        sku: "POLISH-RED",
        track_inventory: true,
        location_overrides: [{
          location_id: "location-1",
          track_inventory: false,
        }],
      },
    }],
  },
};

describe("Square inventory catalog reconciliation runtime", () => {
  it("builds an incremental, deleted-aware provider search without making a call", () => {
    expect(buildSquareInventoryCatalogSearchRequest({
      latestTime: "2026-08-22T16:00:00Z",
      cursor: "page-2",
    })).toEqual({
      object_types: ["ITEM", "ITEM_VARIATION"],
      include_deleted_objects: true,
      include_related_objects: true,
      begin_time: "2026-08-22T16:00:00Z",
      cursor: "page-2",
    });
    expect(buildSquareInventoryCatalogSearchRequest({
      latestTime: "local-clock",
      cursor: null,
    })).toBeNull();
  });

  it("keeps only REGULAR retail variations and applies bound-location overrides", () => {
    expect(sanitizeSquareInventoryCatalogPage({
      latest_time: "2026-08-22T17:00:01Z",
      cursor: "next-page",
      objects: [
        item,
        {
          type: "ITEM",
          id: "item-service",
          item_data: {
            name: "Gel Manicure",
            product_type: "APPOINTMENTS_SERVICE",
            variations: [{
              type: "ITEM_VARIATION",
              id: "variation-service",
              version: 1,
              updated_at: "2026-08-22T17:00:00Z",
              item_variation_data: {
                item_id: "item-service",
                name: "60 minutes",
                track_inventory: true,
              },
            }],
          },
        },
      ],
    }, "location-1")).toEqual({
      latestTime: "2026-08-22T17:00:01Z",
      cursor: "next-page",
      variations: [{
        id: "variation-red",
        item_id: "item-retail-polish",
        version: "1724346000000",
        product_type: "REGULAR",
        item_name: "Retail Polish",
        variation_name: "Red",
        sku: "POLISH-RED",
        is_deleted: false,
        track_inventory: false,
        present_at_bound_location: true,
        updated_at: "2026-08-22T17:00:00Z",
      }],
    });
  });

  it("fails closed on missing parent context, malformed location data, or unsafe int64", () => {
    expect(sanitizeSquareInventoryCatalogPage({
      latest_time: "2026-08-22T17:00:01Z",
      objects: [{
        type: "ITEM_VARIATION",
        id: "orphan",
        version: 1,
        updated_at: "2026-08-22T17:00:00Z",
        item_variation_data: { item_id: "missing", name: "Orphan", track_inventory: true },
      }],
    }, "location-1")).toBeNull();

    expect(sanitizeSquareInventoryCatalogPage({
      latest_time: "2026-08-22T17:00:01Z",
      objects: [{ ...item, absent_at_location_ids: ["bad\nlocation"] }],
    }, "location-1")).toBeNull();

    const unsafe = structuredClone(item);
    unsafe.item_data.variations[0].version = Number.MAX_SAFE_INTEGER + 1;
    expect(sanitizeSquareInventoryCatalogPage({
      latest_time: "2026-08-22T17:00:01Z",
      objects: [unsafe],
    }, "location-1")).toBeNull();
  });

  it("accepts an empty incremental page so latest_time can advance", () => {
    expect(sanitizeSquareInventoryCatalogPage({
      latest_time: "2026-08-22T17:10:00Z",
      objects: [],
    }, "location-1")).toEqual({
      latestTime: "2026-08-22T17:10:00Z",
      cursor: null,
      variations: [],
    });
  });
});
