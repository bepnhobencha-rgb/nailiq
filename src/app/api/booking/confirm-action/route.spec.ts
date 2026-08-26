import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  confirm: vi.fn(),
  rate: vi.fn(),
}));
vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({
  consumeBookingManagementRateLimit: mocks.rate,
}));

vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({
  inspectBookingManagementCapability: mocks.inspect,
  confirmBookingWithManagementCapability: mocks.confirm,
}));

import { GET, POST } from "./route";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function post(body: unknown, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  return new Request("https://nailiq.test/api/booking/confirm-action", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(raw)),
      ...headers,
    },
    body: raw,
  });
}

function expectPrivateHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
}

describe("booking confirmation management route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rate.mockResolvedValue("allowed");
    mocks.inspect.mockResolvedValue({
      ok: true,
      inspection: {
        action: "confirm",
        scopeKind: "booking",
        epoch: 1,
        expiresAt: "2099-08-20T18:00:00.000Z",
        booking: {
          status: "pending",
          startTimeUtc: "2099-08-20T17:00:00.000Z",
          endTimeUtc: "2099-08-20T18:00:00.000Z",
          serviceName: "Manicure",
          staffName: "QA Staff",
          salonSlug: "qa-salon",
          salonName: "QA Salon",
          salonTimezone: "America/Los_Angeles",
        },
        group: null,
      },
    });
    mocks.confirm.mockResolvedValue({
      ok: true,
      result: {
        code: "confirmed",
        action: "confirm",
        bookingId: "33333333-3333-4333-8333-333333333333",
        salonId: "11111111-1111-4111-8111-111111111111",
        serviceId: "44444444-4444-4444-8444-444444444444",
        staffId: "55555555-5555-4555-8555-555555555555",
        serviceName: "Manicure",
        staffName: "QA Staff",
        salonSlug: "qa-salon",
        salonName: "QA Salon",
        salonTimezone: "America/Los_Angeles",
        status: "confirmed",
        actionEpoch: 2,
        transitionVersion: null,
        previousStartTimeUtc: "2099-08-20T17:00:00.000Z",
        startTimeUtc: "2099-08-20T17:00:00.000Z",
        endTimeUtc: "2099-08-20T18:00:00.000Z",
        idempotent: false,
        cancelPreview: null,
        promotedWaitlist: null,
      },
    });
  });

  it("GET only inspects the confirm capability and returns hardened minimal data", async () => {
    const response = await GET(new Request(
      `https://nailiq.test/api/booking/confirm-action?token=${TOKEN}`,
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      booking: { status: "pending", serviceName: "Manicure", salonSlug: "qa-salon" },
    });
    expect(mocks.inspect).toHaveBeenCalledWith({ tokenId: TOKEN, expectedAction: "confirm" });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expectPrivateHeaders(response);
  });

  it("denies missing and cross-origin POST before the mutation helper", async () => {
    for (const origin of [undefined, "https://evil.test"]) {
      const response = await POST(post(
        { token: TOKEN, requestId: REQUEST_ID },
        origin ? { origin } : {},
      ));
      expect(response.status).toBe(403);
      expectPrivateHeaders(response);
    }
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("accepts a bounded body without Content-Length and rejects declared or actual overflow", async () => {
    const noLength = new Request("https://nailiq.test/api/booking/confirm-action", {
      method: "POST",
      headers: { origin: "https://nailiq.test", "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, requestId: REQUEST_ID }),
    });
    expect((await POST(noLength)).status).toBe(200);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);

    const oversized = post(
      { token: TOKEN, requestId: REQUEST_ID },
      { origin: "https://nailiq.test", "content-length": "1025" },
    );
    expect((await POST(oversized)).status).toBe(400);

    const spoofedSmallLength = post(
      { token: TOKEN, requestId: REQUEST_ID, padding: "x".repeat(1500) },
      { origin: "https://nailiq.test", "content-length": "10" },
    );
    expect((await POST(spoofedSmallLength)).status).toBe(400);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });

  it("POST performs one explicit same-origin mutation with the stable request id", async () => {
    const response = await POST(post(
      { token: TOKEN, requestId: REQUEST_ID },
      { origin: "https://nailiq.test", "sec-fetch-site": "same-origin" },
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      code: "confirmed",
      booking: { status: "confirmed" },
      idempotent: false,
    });
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.confirm).toHaveBeenCalledWith({ tokenId: TOKEN, requestId: REQUEST_ID });
    expectPrivateHeaders(response);
  });

  it("fails closed on inspection and mutation dependency errors", async () => {
    mocks.inspect.mockResolvedValueOnce({ ok: false, code: "management_unavailable" });
    const getResponse = await GET(new Request(
      `https://nailiq.test/api/booking/confirm-action?token=${TOKEN}`,
    ));
    expect(getResponse.status).toBe(503);
    expect(mocks.confirm).not.toHaveBeenCalled();

    mocks.confirm.mockResolvedValueOnce({ ok: false, code: "action_mismatch" });
    const postResponse = await POST(post(
      { token: TOKEN, requestId: REQUEST_ID },
      { origin: "https://nailiq.test" },
    ));
    expect(postResponse.status).toBe(409);
  });

  it("rate limiter threshold and failure both block before capability RPC", async () => {
    for (const rate of ["limited", "unavailable"] as const) {
      mocks.rate.mockResolvedValueOnce(rate);
      const response = await GET(new Request(
        `https://nailiq.test/api/booking/confirm-action?token=${TOKEN}`,
      ));
      expect(response.status).toBe(rate === "limited" ? 429 : 503);
    }
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("rejects missing or wrong JSON content type before rate limit and mutation", async () => {
    for (const contentType of [undefined, "text/plain"]) {
      const raw = JSON.stringify({ token: TOKEN, requestId: REQUEST_ID });
      const headers: Record<string, string> = {
        origin: "https://nailiq.test",
        "content-length": String(Buffer.byteLength(raw)),
      };
      if (contentType) headers["content-type"] = contentType;
      const response = await POST(new Request(
        "https://nailiq.test/api/booking/confirm-action",
        { method: "POST", headers, body: raw },
      ));
      expect(response.status).toBe(400);
    }
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
