import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  MAX_SQUARE_WEBHOOK_BYTES,
  parseSquareEvent,
  readSquareWebhookBody,
  resolveSquareWebhookProfile,
  sanitizeSquareOptionalEvent,
  sanitizeSquareRefundEvent,
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

  it("projects an exact refund.updated revision without customer or card material", () => {
    const event = parseSquareEvent(JSON.stringify({
      merchant_id: "merchant-1",
      type: "refund.updated",
      event_id: "refund-event-1",
      created_at: "2026-08-23T17:00:01Z",
      data: {
        id: "refund-1",
        object: {
          refund: {
            id: "refund-1",
            payment_id: "payment-1",
            location_id: "location-1",
            status: "COMPLETED",
            amount_money: { amount: 1_250, currency: "CAD" },
            updated_at: "2026-08-23T17:00:00.123Z",
            reason: "customer phone +16045550199",
            destination_details: { card_details: { card: "secret" } },
          },
        },
      },
    }));

    expect(event).not.toBeNull();
    expect(sanitizeSquareRefundEvent(event!)).toEqual({
      refundId: "refund-1",
      paymentId: "payment-1",
      locationId: "location-1",
      status: "COMPLETED",
      amountCents: 1_250,
      currency: "CAD",
      updatedAt: "2026-08-23T17:00:00.123Z",
    });
    expect(JSON.stringify(sanitizeSquareRefundEvent(event!))).not.toMatch(/16045550199|secret|reason/);
  });

  it.each([
    ["mismatched data id", { dataId: "other-refund" }],
    ["missing location", { location_id: undefined }],
    ["unsupported status", { status: "CANCELED" }],
    ["zero amount", { amount_money: { amount: 0, currency: "CAD" } }],
    ["non-canonical currency", { amount_money: { amount: 500, currency: "cad" } }],
    ["overflowing database integer", { amount_money: { amount: 2_147_483_648, currency: "CAD" } }],
    ["invalid update time", { updated_at: "2026-08-23" }],
    ["whitespace provider id", { id: "refund 1" }],
  ])("rejects refund material with %s", (_name, override) => {
    const { dataId = "refund-1", ...refundOverride } = override as Record<string, unknown>;
    const event = parseSquareEvent(JSON.stringify({
      merchant_id: "merchant-1",
      type: "refund.updated",
      event_id: "refund-event-1",
      created_at: "2026-08-23T17:00:01Z",
      data: {
        id: dataId,
        object: {
          refund: {
            id: "refund-1",
            payment_id: "payment-1",
            location_id: "location-1",
            status: "PENDING",
            amount_money: { amount: 500, currency: "CAD" },
            updated_at: "2026-08-23T17:00:00Z",
            ...refundOverride,
          },
        },
      },
    }));
    expect(event).not.toBeNull();
    expect(sanitizeSquareRefundEvent(event!)).toBeNull();
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
            program_id: "program-1",
            balance: 12,
            lifetime_points: 44,
            updated_at: "2026-08-20T11:59:59Z",
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
    expect(sanitized?.material).toEqual({
      entity: {
        id: "account-1",
        program_id: "program-1",
        balance: 12,
        lifetime_points: 44,
        updated_at: "2026-08-20T11:59:59Z",
      },
    });

    const promotion = parseSquareEvent(JSON.stringify({
      merchant_id: "merchant",
      type: "loyalty.promotion.updated",
      event_id: "event-2",
      created_at: "2026-08-20T12:00:00-07:00",
      data: { id: "promotion-1", object: { loyalty_promotion: { id: "promotion-1", status: "CANCELED" } } },
    }));
    expect(sanitizeSquareOptionalEvent(promotion!)?.entityId).toBe("promotion-1");
  });

  it("normalizes immutable loyalty event metadata without customer identity", () => {
    const event = parseSquareEvent(JSON.stringify({
      merchant_id: "merchant",
      type: "loyalty.event.created",
      event_id: "webhook-event-1",
      created_at: "2026-08-20T12:00:01Z",
      data: {
        id: "loyalty-event-1",
        object: {
          loyalty_event: {
            id: "loyalty-event-1",
            type: "ACCUMULATE_POINTS",
            created_at: "2026-08-20T12:00:00Z",
            loyalty_account_id: "account-1",
            location_id: "location-1",
            source: "LOYALTY_API",
            accumulate_points: {
              loyalty_program_id: "program-1",
              points: 12,
              order_id: "order-1",
            },
            customer_id: "must-not-survive",
          },
        },
      },
    }));
    expect(sanitizeSquareOptionalEvent(event!)).toEqual({
      entityId: "loyalty-event-1",
      material: {
        entity: {
          id: "loyalty-event-1",
          type: "ACCUMULATE_POINTS",
          loyalty_account_id: "account-1",
          program_id: "program-1",
          created_at: "2026-08-20T12:00:00Z",
          points_delta: 12,
          order_id: "order-1",
          location_id: "location-1",
          source: "LOYALTY_API",
        },
      },
    });
  });

  it("keeps Square gift card snapshots GAN-free and provider-authoritative", () => {
    const event = parseSquareEvent(JSON.stringify({
      merchant_id: "merchant",
      type: "gift_card.updated",
      event_id: "gift-card-event-1",
      created_at: "2026-08-22T17:00:00Z",
      data: {
        id: "gftc:card-1",
        object: {
          gift_card: {
            id: "gftc:card-1",
            type: "DIGITAL",
            gan_source: "SQUARE",
            state: "ACTIVE",
            balance_money: { amount: 3750, currency: "CAD" },
            created_at: "2026-08-22T16:00:00Z",
            gan: "7783320000000000",
            customer_ids: ["customer-secret"],
          },
        },
      },
    }));
    expect(sanitizeSquareOptionalEvent(event!)).toEqual({
      entityId: "gftc:card-1",
      material: {
        entity: {
          id: "gftc:card-1",
          type: "DIGITAL",
          gan_source: "SQUARE",
          state: "ACTIVE",
          balance_money: { amount: 3750, currency: "CAD" },
          created_at: "2026-08-22T16:00:00Z",
        },
      },
    });
    expect(JSON.stringify(sanitizeSquareOptionalEvent(event!))).not.toMatch(/gan\"|customer-secret/);
  });

  it("normalizes append-only partial redeem and refund activity revisions", () => {
    const redeem = parseSquareEvent(JSON.stringify({
      merchant_id: "merchant",
      type: "gift_card.activity.updated",
      event_id: "gift-activity-webhook-1",
      created_at: "2026-08-22T17:03:00Z",
      data: {
        id: "gcact:redeem-1",
        object: {
          gift_card_activity: {
            id: "gcact:redeem-1",
            type: "REDEEM",
            location_id: "location-1",
            created_at: "2026-08-22T17:02:00Z",
            gift_card_id: "gftc:card-1",
            gift_card_gan: "7783320000000000",
            gift_card_balance_money: { amount: 3750, currency: "CAD" },
            redeem_activity_details: {
              amount_money: { amount: 1250, currency: "CAD" },
              payment_id: "payment-1",
              reference_id: "booking-safe-reference",
              status: "COMPLETED",
            },
          },
        },
      },
    }));
    expect(sanitizeSquareOptionalEvent(redeem!)).toEqual({
      entityId: "gcact:redeem-1",
      material: {
        entity: {
          id: "gcact:redeem-1",
          type: "REDEEM",
          location_id: "location-1",
          created_at: "2026-08-22T17:02:00Z",
          gift_card_id: "gftc:card-1",
          gift_card_balance_money: { amount: 3750, currency: "CAD" },
          amount_money: { amount: 1250, currency: "CAD" },
          status: "COMPLETED",
          payment_id: "payment-1",
          reference_id: "booking-safe-reference",
        },
      },
    });
    expect(JSON.stringify(sanitizeSquareOptionalEvent(redeem!))).not.toContain("7783320000000000");

    const refund = parseSquareEvent(JSON.stringify({
      merchant_id: "merchant",
      type: "gift_card.activity.created",
      event_id: "gift-activity-webhook-2",
      created_at: "2026-08-22T17:04:00Z",
      data: {
        id: "gcact:refund-1",
        object: {
          gift_card_activity: {
            id: "gcact:refund-1",
            type: "REFUND",
            location_id: "location-1",
            created_at: "2026-08-22T17:04:00Z",
            gift_card_id: "gftc:card-1",
            gift_card_balance_money: { amount: 4250, currency: "CAD" },
            refund_activity_details: {
              amount_money: { amount: 500, currency: "CAD" },
              payment_id: "payment-1",
              redeem_activity_id: "gcact:redeem-1",
            },
          },
        },
      },
    }));
    expect(sanitizeSquareOptionalEvent(refund!)?.material).toMatchObject({
      entity: {
        type: "REFUND",
        amount_money: { amount: 500, currency: "CAD" },
        payment_id: "payment-1",
        redeem_activity_id: "gcact:redeem-1",
      },
    });
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
