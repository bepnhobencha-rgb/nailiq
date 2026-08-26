import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  looseServiceClient: vi.fn(),
  getBooking: vi.fn(),
  processWixBookingEvent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/integrations/wix/looseDb", () => ({
  looseServiceClient: mocks.looseServiceClient,
}));
vi.mock("@/shared/integrations/wix/client", () => ({
  getBooking: mocks.getBooking,
}));
vi.mock("@/shared/integrations/wix/sync", () => ({
  processWixBookingEvent: mocks.processWixBookingEvent,
}));

import { POST } from "./route";
import { MAX_WIX_WEBHOOK_BYTES } from "@/shared/integrations/wix/webhookRuntime";

const url = "https://nailiq.test/api/webhooks/wix";
const siteId = "site-123";
const entityId = "booking-123";
const body = JSON.stringify({
  id: "event-123",
  eventTime: "2026-08-22T18:00:00.000Z",
  entityFqdn: "wix.bookings.v2.booking",
  slug: "updated",
  entityId,
  siteId,
});
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function signature(raw: string | Uint8Array): string {
  const signer = createSign("RSA-SHA256");
  signer.update(raw);
  signer.end();
  return signer.sign(keys.privateKey, "base64");
}

function db(options?: { publicKey?: string | null; selectError?: unknown; updateError?: unknown }) {
  const selectQuery = {
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: options?.selectError
        ? null
        : {
            salon_id: "salon-123",
            auto_approve: false,
            wix_webhook_public_key: options?.publicKey === undefined ? publicKey : options.publicKey,
          },
      error: options?.selectError ?? null,
    }),
  };
  selectQuery.eq.mockReturnValue(selectQuery);
  const updateResult = { error: options?.updateError ?? null };
  const updateQuery = {
    eq: vi.fn(),
    then: (resolve: (value: typeof updateResult) => unknown) =>
      Promise.resolve(updateResult).then(resolve),
  };
  updateQuery.eq.mockReturnValue(updateQuery);
  const select = vi.fn(() => selectQuery);
  const update = vi.fn(() => updateQuery);
  const from = vi.fn(() => ({ select, update }));
  const rpc = vi.fn(async (fn: string) => {
    if (fn === "record_wix_webhook_event") {
      return { data: { success: true, code: "event_recorded", inbox_id: "inbox-123" }, error: null };
    }
    if (fn === "claim_wix_webhook_event") {
      return {
        data: {
          success: true,
          code: "event_claimed",
          inbox_id: "inbox-123",
          claim_token: "claim-123",
        },
        error: null,
      };
    }
    return { data: { success: true, code: "event_completed" }, error: null };
  });
  return { client: { from, rpc }, from, update, rpc };
}

function request(raw: string | Uint8Array, headers?: Record<string, string>) {
  return new Request(url, {
    method: "POST",
    body: typeof raw === "string" ? raw : Buffer.from(raw),
    headers: {
      "wix-site-id": siteId,
      ...headers,
    },
  });
}

describe("signed Wix webhook ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBooking.mockResolvedValue({ id: entityId, status: "CONFIRMED" });
    mocks.processWixBookingEvent.mockResolvedValue({ action: "updated", bookingId: "local-1" });
  });

  it("retires unsigned Automations before any DB or provider access", async () => {
    const database = db();
    mocks.looseServiceClient.mockReturnValue(database.client);
    const response = await POST(request(body) as never);
    expect(response.status).toBe(401);
    expect(database.from).not.toHaveBeenCalled();
    expect(mocks.getBooking).not.toHaveBeenCalled();
    expect(mocks.processWixBookingEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing Content-Length", {}],
    ["spoofed small Content-Length", { "content-length": "1" }],
  ])("rejects an oversized actual stream with %s before DB/provider", async (_label, extra) => {
    const database = db();
    mocks.looseServiceClient.mockReturnValue(database.client);
    const oversized = new Uint8Array(MAX_WIX_WEBHOOK_BYTES + 1).fill(65);
    const response = await POST(request(oversized, {
      "x-wix-signature": "A".repeat(32),
      ...extra,
    }) as never);
    expect(response.status).toBe(413);
    expect(database.from).not.toHaveBeenCalled();
    expect(mocks.getBooking).not.toHaveBeenCalled();
  });

  it("fails closed when the enabled integration has no configured public key", async () => {
    const database = db({ publicKey: null });
    mocks.looseServiceClient.mockReturnValue(database.client);
    const response = await POST(request(body, { "x-wix-signature": signature(body) }) as never);
    expect(response.status).toBe(503);
    expect(database.update).not.toHaveBeenCalled();
    expect(mocks.getBooking).not.toHaveBeenCalled();
    expect(mocks.processWixBookingEvent).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature before provider fetch or DB mutation", async () => {
    const database = db();
    mocks.looseServiceClient.mockReturnValue(database.client);
    const response = await POST(request(body, { "x-wix-signature": signature(`${body}changed`) }) as never);
    expect(response.status).toBe(401);
    expect(database.update).not.toHaveBeenCalled();
    expect(mocks.getBooking).not.toHaveBeenCalled();
    expect(mocks.processWixBookingEvent).not.toHaveBeenCalled();
  });

  it("rejects the old wrapped Automation event even if a signature header is supplied", async () => {
    const database = db();
    mocks.looseServiceClient.mockReturnValue(database.client);
    const wrapped = JSON.stringify({ data: JSON.parse(body) });
    const response = await POST(request(wrapped, { "x-wix-signature": signature(wrapped) }) as never);
    expect(response.status).toBe(400);
    expect(database.from).not.toHaveBeenCalled();
    expect(mocks.getBooking).not.toHaveBeenCalled();
  });

  it("accepts a bounded body without Content-Length only after exact signature verification", async () => {
    const database = db();
    mocks.looseServiceClient.mockReturnValue(database.client);
    const response = await POST(request(body, { "x-wix-signature": signature(body) }) as never);
    expect(response.status).toBe(200);
    expect(mocks.getBooking).toHaveBeenCalledWith(siteId, entityId);
    expect(mocks.processWixBookingEvent).toHaveBeenCalledWith(
      "salon-123",
      { id: entityId, status: "CONFIRMED" },
      false,
    );
    expect(database.update).toHaveBeenCalledTimes(1);
    expect(database.rpc).toHaveBeenCalledWith(
      "record_wix_webhook_event",
      expect.objectContaining({
        p_event_id: "event-123",
        p_entity_id: entityId,
        p_event_slug: "updated",
      }),
    );
    expect(database.rpc).toHaveBeenCalledWith(
      "complete_wix_webhook_event",
      expect.objectContaining({ p_status: "processed" }),
    );
  });
});
