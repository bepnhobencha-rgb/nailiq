import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createService: vi.fn(),
  rpc: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createService,
}));
vi.mock("resend", () => ({
  Resend: class {
    webhooks = { verify: mocks.verify };
  },
}));

import { POST } from "./route";

const url = "https://nailiq.test/api/webhooks/resend";
const occurredAt = "2026-08-28T02:45:00.000Z";

function payload(type = "email.delivered") {
  return JSON.stringify({
    type,
    created_at: occurredAt,
    data: {
      created_at: "2026-08-28T02:44:58.000Z",
      email_id: "resend-message-1",
      from: "NailIQ <noreply@nailiq.ca>",
      to: ["Owner@Example.COM"],
      subject: "must-not-persist",
      tags: {
        nailiq_flow: "owner_booking",
        nailiq_claim: "33333333-3333-4333-8333-333333333333",
      },
    },
  });
}

function customerPayload() {
  const parsed = JSON.parse(payload()) as {
    data: { to: string[]; tags: Record<string, string> };
  };
  parsed.data.to = ["Guest@Example.COM"];
  parsed.data.tags = {
    nailiq_flow: "customer_booking",
    nailiq_claim_kind: "reminder",
    nailiq_claim: "44444444-4444-4444-8444-444444444444",
  };
  return JSON.stringify(parsed);
}

function request(raw: string, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": "evt_test_1",
      "svix-timestamp": "1787885100",
      "svix-signature": "v1,test-signature",
      ...headers,
    },
    body: raw,
  });
}

describe("Resend owner delivery webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_test_owner_delivery_secret");
    mocks.createService.mockReturnValue({ rpc: mocks.rpc });
    mocks.rpc.mockResolvedValue({
      data: { success: true, code: "event_applied" },
      error: null,
    });
    mocks.verify.mockImplementation(({ payload: raw }: { payload: string }) => JSON.parse(raw));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("rejects missing configuration before reading provider material", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    const response = await POST(request(payload()));
    expect(response.status).toBe(503);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures before database access", async () => {
    mocks.verify.mockImplementation(() => { throw new Error("bad signature"); });
    const response = await POST(request(payload()));
    expect(response.status).toBe(401);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before signature or database access", async () => {
    const response = await POST(request("x".repeat(256 * 1024 + 1)));
    expect(response.status).toBe(413);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("records only signed, fingerprinted delivery material without recipient PII", async () => {
    const raw = payload();
    const response = await POST(request(raw));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, code: "event_applied" });

    expect(mocks.verify).toHaveBeenCalledWith({
      payload: raw,
      webhookSecret: "whsec_test_owner_delivery_secret",
      headers: {
        id: "evt_test_1",
        timestamp: "1787885100",
        signature: "v1,test-signature",
      },
    });
    expect(mocks.rpc).toHaveBeenCalledWith("record_resend_owner_delivery_event", {
      p_claim_id: "33333333-3333-4333-8333-333333333333",
      p_provider_event_id: "evt_test_1",
      p_provider_message_id: "resend-message-1",
      p_event_type: "email.delivered",
      p_recipient_fingerprint: createHash("sha256")
        .update("owner@example.com")
        .digest("hex"),
      p_occurred_at: occurredAt,
      p_payload_fingerprint: createHash("sha256").update(raw).digest("hex"),
    });
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain("Owner@Example.COM");
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain("must-not-persist");
  });

  it("routes customer booking receipts to the generic customer ledger", async () => {
    const raw = customerPayload();
    const response = await POST(request(raw));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("record_resend_customer_delivery_event", {
      p_claim_kind: "reminder",
      p_claim_id: "44444444-4444-4444-8444-444444444444",
      p_provider_event_id: "evt_test_1",
      p_provider_message_id: "resend-message-1",
      p_event_type: "email.delivered",
      p_recipient_fingerprint: createHash("sha256")
        .update("guest@example.com")
        .digest("hex"),
      p_occurred_at: occurredAt,
      p_payload_fingerprint: createHash("sha256").update(raw).digest("hex"),
    });
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain("Guest@Example.COM");
  });

  it("acknowledges signed non-delivery events without touching the database", async () => {
    const response = await POST(request(payload("email.opened")));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, code: "event_ignored" });
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("ignores signed delivery events that are not tagged as owner booking mail", async () => {
    const parsed = JSON.parse(payload()) as { data: Record<string, unknown> };
    delete parsed.data.tags;
    const response = await POST(request(JSON.stringify(parsed)));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, code: "event_ignored" });
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("returns retryable service unavailable when durable storage fails", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    const response = await POST(request(payload()));
    expect(response.status).toBe(503);
  });

  it("asks the provider to retry an unexpected pending correlation", async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: true, code: "event_pending_match" },
      error: null,
    });
    const response = await POST(request(payload()));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "event_pending_match",
    });
  });

  it("returns conflict for a reused provider event identity with changed material", async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: false, code: "event_conflict" },
      error: null,
    });
    const response = await POST(request(payload()));
    expect(response.status).toBe(409);
  });
});
