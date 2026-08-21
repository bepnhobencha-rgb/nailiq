import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  MAX_SQUARE_WEBHOOK_BYTES,
  parseSquareEvent,
  readSquareWebhookBody,
  resolveSquareWebhookProfile,
  sanitizeSquareOptionalEvent,
  verifySquareWebhookSignature,
} from "../webhookRuntime";

const url = "https://nailiq.test/api/webhooks/square";
const key = "square-test-signature-key";
const profile = {
  applicationId: "sq-app",
  environment: "sandbox" as const,
  notificationUrl: url,
  signatureKey: key,
};

describe("Square webhook runtime boundary", () => {
  it("loads only an exact URL/application/environment-bound profile", () => {
    const config = JSON.stringify([profile]);
    expect(resolveSquareWebhookProfile(url, config)).toEqual(profile);
    expect(resolveSquareWebhookProfile(`${url}?other=1`, config)).toBeNull();
    expect(resolveSquareWebhookProfile(url, JSON.stringify([
      profile,
      { ...profile, applicationId: "duplicate" },
    ]))).toBeNull();
  });

  it("verifies the raw bytes and notification URL with constant-time-compatible digest lengths", () => {
    const bytes = new TextEncoder().encode('{"event_id":"evt"}\n');
    const signature = createHmac("sha256", key).update(url).update(bytes).digest("base64");
    expect(verifySquareWebhookSignature({ profile, body: bytes, signatureHeader: signature })).toBe(true);
    expect(verifySquareWebhookSignature({
      profile,
      body: new TextEncoder().encode('{"event_id":"changed"}'),
      signatureHeader: signature,
    })).toBe(false);
    expect(verifySquareWebhookSignature({ profile, body: bytes, signatureHeader: "bad" })).toBe(false);
  });

  it("caps the actual stream even with a missing or spoofed Content-Length", async () => {
    const exact = new Uint8Array(MAX_SQUARE_WEBHOOK_BYTES).fill(65);
    await expect(readSquareWebhookBody(new Request(url, { method: "POST", body: exact })))
      .resolves.toMatchObject({ ok: true });
    const oversized = new Uint8Array(MAX_SQUARE_WEBHOOK_BYTES + 1).fill(65);
    await expect(readSquareWebhookBody(new Request(url, {
      method: "POST",
      headers: { "content-length": "1" },
      body: oversized,
    }))).resolves.toEqual({ ok: false, code: "body_too_large" });
  });

  it("keeps loyalty promotion/account material PII-free", () => {
    const event = parseSquareEvent(JSON.stringify({
      merchant_id: "merchant",
      type: "loyalty.account.updated",
      event_id: "event-1",
      created_at: "2026-08-20T12:00:00Z",
      data: {
        id: "account-1",
        object: {
          loyalty_account: {
            id: "account-1",
            balance: 12,
            customer_id: "customer-secret",
            mapping: { phone_number: "+16045550199" },
          },
        },
      },
    }));
    expect(event).not.toBeNull();
    const sanitized = sanitizeSquareOptionalEvent(event!);
    expect(sanitized?.entityId).toBe("account-1");
    expect(JSON.stringify(sanitized)).not.toContain("phone");
    expect(JSON.stringify(sanitized)).not.toContain("customer-secret");

    const promotion = parseSquareEvent(JSON.stringify({
      merchant_id: "merchant",
      type: "loyalty.promotion.updated",
      event_id: "event-2",
      created_at: "2026-08-20T12:00:00-07:00",
      data: { id: "promotion-1", object: { loyalty_promotion: { id: "promotion-1", status: "CANCELED" } } },
    }));
    expect(sanitizeSquareOptionalEvent(promotion!)?.entityId).toBe("promotion-1");
  });

  it("normalizes official catalog and inventory shapes", () => {
    const catalog = parseSquareEvent(JSON.stringify({
      merchant_id: "merchant",
      type: "catalog.version.updated",
      event_id: "catalog-event",
      created_at: "2026-08-20T12:00:00Z",
      data: { id: "", object: { catalog_version: { updated_at: "2026-08-20T11:59:59Z" } } },
    }));
    expect(sanitizeSquareOptionalEvent(catalog!)).toEqual({
      entityId: "merchant",
      material: { catalog_updated_at: "2026-08-20T11:59:59Z" },
    });

    const inventory = parseSquareEvent(JSON.stringify({
      merchant_id: "merchant",
      type: "inventory.count.updated",
      event_id: "inventory-event",
      created_at: "2026-08-20T12:00:00Z",
      data: {
        id: "inventory-1",
        object: { inventory_counts: [{
          calculated_at: "2026-08-20T11:59:59Z",
          catalog_object_id: "variation-1",
          catalog_object_type: "ITEM_VARIATION",
          location_id: "location-1",
          quantity: "2.5",
          state: "IN_STOCK",
        }] },
      },
    }));
    expect(sanitizeSquareOptionalEvent(inventory!)?.material).toEqual({
      counts: [{
        calculated_at: "2026-08-20T11:59:59Z",
        catalog_object_id: "variation-1",
        catalog_object_type: "ITEM_VARIATION",
        location_id: "location-1",
        quantity: "2.5",
        state: "IN_STOCK",
      }],
    });
  });
});
