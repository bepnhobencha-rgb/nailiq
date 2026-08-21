import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimWaitlistSlot: vi.fn(),
  rate: vi.fn(),
}));

vi.mock("@/shared/booking/waitlistClaim", () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return {
    claimWaitlistSlot: mocks.claimWaitlistSlot,
    parseWaitlistClaimToken: (value: unknown) =>
      typeof value === "string" && uuid.test(value.trim()) ? value.trim().toLowerCase() : null,
  };
});
vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({
  consumeBookingManagementRateLimit: mocks.rate,
}));

import { POST } from "./route";

const TOKEN = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "223e4567-e89b-42d3-a456-426614174000";

function request(
  body: unknown = { token: TOKEN, requestId: REQUEST_ID },
  headers: Record<string, string> = {},
) {
  const encoded = JSON.stringify(body);
  const requestHeaders: Record<string, string> = {
    Origin: "https://nailiq.test",
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
    "Content-Length": String(new TextEncoder().encode(encoded).byteLength),
    ...headers,
  };
  if (requestHeaders["Content-Length"] === "") delete requestHeaders["Content-Length"];
  return new Request("https://nailiq.test/api/booking/waitlist-claim", {
    method: "POST",
    headers: requestHeaders,
    body: encoded,
  });
}

describe("POST /api/booking/waitlist-claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rate.mockResolvedValue("allowed");
  });

  it("rejects a scanner/cross-origin mutation before calling the claim boundary", async () => {
    const response = await POST(request(undefined, { Origin: "https://scanner.example" }));
    expect(response.status).toBe(403);
    expect(mocks.claimWaitlistSlot).not.toHaveBeenCalled();
  });

  it("performs exactly one mutation for an explicit same-origin POST", async () => {
    mocks.claimWaitlistSlot.mockResolvedValue({ ok: true, outcome: "booked" });
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: "booked" });
    expect(mocks.claimWaitlistSlot).toHaveBeenCalledTimes(1);
    expect(mocks.claimWaitlistSlot).toHaveBeenCalledWith(TOKEN, REQUEST_ID);
  });

  it("replays the same stable request after response loss without changing intent", async () => {
    mocks.claimWaitlistSlot
      .mockResolvedValueOnce({ ok: true, outcome: "booked" })
      .mockResolvedValueOnce({ ok: true, outcome: "booked" });
    const first = await POST(request());
    const replay = await POST(request());
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(mocks.claimWaitlistSlot).toHaveBeenNthCalledWith(1, TOKEN, REQUEST_ID);
    expect(mocks.claimWaitlistSlot).toHaveBeenNthCalledWith(2, TOKEN, REQUEST_ID);
  });

  it("returns a generic duplicate response and never exposes lifecycle or customer facts", async () => {
    mocks.claimWaitlistSlot.mockResolvedValue({ ok: false, reason: "unavailable" });
    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(body)).not.toMatch(/expired|claimed|client|phone|email|booking_id/i);
    expect(mocks.claimWaitlistSlot).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a database error and supplies private response headers", async () => {
    mocks.claimWaitlistSlot.mockResolvedValue({ ok: false, reason: "error" });
    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("rejects malformed tokens before the mutation helper", async () => {
    const response = await POST(request({ token: "not-a-token", requestId: REQUEST_ID }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, reason: "unavailable" });
    expect(mocks.claimWaitlistSlot).not.toHaveBeenCalled();
  });

  it("rejects JSON-like content types before reading or rate-limiting", async () => {
    const response = await POST(request(undefined, { "Content-Type": "application/json-evil" }));
    expect(response.status).toBe(400);
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.claimWaitlistSlot).not.toHaveBeenCalled();
  });

  it("accepts a bounded stream without Content-Length and still rate-limits before mutation", async () => {
    mocks.claimWaitlistSlot.mockResolvedValue({ ok: true, outcome: "claimed" });
    const response = await POST(request(undefined, { "Content-Length": "" }));
    expect(response.status).toBe(200);
    expect(mocks.rate).toHaveBeenCalledWith(expect.objectContaining({
      tokenId: TOKEN,
      action: "waitlist_claim",
      phase: "mutate",
    }));
  });

  it("rejects an oversized actual stream even when Content-Length is spoofed small", async () => {
    const response = await POST(request({
      token: TOKEN,
      requestId: REQUEST_ID,
      padding: "x".repeat(1500),
    }, { "Content-Length": "100" }));
    expect(response.status).toBe(400);
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.claimWaitlistSlot).not.toHaveBeenCalled();
  });

  it("fails closed when the durable limiter is unavailable", async () => {
    mocks.rate.mockResolvedValue("unavailable");
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.claimWaitlistSlot).not.toHaveBeenCalled();
  });
});
