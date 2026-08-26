import { beforeEach, describe, expect, it, vi } from "vitest";

const inspect = vi.hoisted(() => vi.fn());
const rate = vi.hoisted(() => vi.fn());

vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({
  inspectBookingManagementCapability: inspect,
}));
vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({
  consumeBookingManagementRateLimit: rate,
}));

import { GET } from "./route";

const TOKEN = "11111111-1111-4111-8111-111111111111";

describe("booking status capability route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rate.mockResolvedValue("allowed");
  });

  it("loads only a status capability and returns a PII-free snapshot", async () => {
    inspect.mockResolvedValue({
      ok: true,
      inspection: {
        action: "status",
        scopeKind: "booking_own",
        epoch: 1,
        expiresAt: "2099-08-20T19:00:00.000Z",
        booking: {
          status: "confirmed",
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
    const response = await GET(new Request(
      `https://nailiq.test/api/booking/status?token=${TOKEN}`,
    ));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, booking: { status: "confirmed", salonSlug: "qa-salon" } });
    expect(JSON.stringify(body)).not.toMatch(/client|phone|email|bookingId/i);
    expect(inspect).toHaveBeenCalledWith({ tokenId: TOKEN, expectedAction: "status" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("fails closed without leaking dependency details", async () => {
    inspect.mockResolvedValue({ ok: false, code: "management_unavailable" });
    const response = await GET(new Request(
      `https://nailiq.test/api/booking/status?token=${TOKEN}`,
    ));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: "management_unavailable" });
  });

  it("blocks rate limit failure before capability inspection", async () => {
    rate.mockResolvedValue("unavailable");
    const response = await GET(new Request(
      `https://nailiq.test/api/booking/status?token=${TOKEN}`,
    ));
    expect(response.status).toBe(503);
    expect(inspect).not.toHaveBeenCalled();
  });
});
