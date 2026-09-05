import { beforeEach, describe, expect, it, vi } from "vitest";

const inspect = vi.hoisted(() => vi.fn());
const rate = vi.hoisted(() => vi.fn());
const eta = vi.hoisted(() => vi.fn());

vi.mock("@/shared/booking/bookingManagementCapabilities", () => ({
  inspectBookingManagementCapability: inspect,
}));
vi.mock("@/shared/booking/bookingManagementRateLimit", () => ({
  consumeBookingManagementRateLimit: rate,
}));
vi.mock("@/shared/turniq/customerStatusEtaLoader", () => ({
  loadTurnIqCustomerStatusEta: eta,
}));

import { GET } from "./route";

const TOKEN = "11111111-1111-4111-8111-111111111111";

describe("booking status capability route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rate.mockResolvedValue("allowed");
    eta.mockResolvedValue(null);
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
        context: {
          bookingId: "22222222-2222-4222-8222-222222222222",
          salonId: "33333333-3333-4333-8333-333333333333",
          serviceId: "44444444-4444-4444-8444-444444444444",
          staffId: null,
          durationMinutes: 60,
          timezone: "America/Los_Angeles",
          currentStartTimeUtc: "2099-08-20T17:00:00.000Z",
          currentEndTimeUtc: "2099-08-20T18:00:00.000Z",
          groupId: null,
          isGroupOrganizer: false,
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
    expect(eta).toHaveBeenCalledWith({
      salonId: "33333333-3333-4333-8333-333333333333",
      bookingId: "22222222-2222-4222-8222-222222222222",
      groupId: null,
      bookingStatus: "confirmed",
      currentStartTimeUtc: "2099-08-20T17:00:00.000Z",
      durationMinutes: 60,
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("adds only a privacy-safe TurnIQ estimate after capability validation", async () => {
    inspect.mockResolvedValue({
      ok: true,
      inspection: {
        booking: {
          status: "confirmed",
          startTimeUtc: "2099-08-20T17:00:00.000Z",
          endTimeUtc: "2099-08-20T18:00:00.000Z",
          serviceName: "Manicure",
          staffName: null,
          salonSlug: "qa-salon",
          salonName: "QA Salon",
          salonTimezone: "America/Los_Angeles",
        },
        context: {
          bookingId: "22222222-2222-4222-8222-222222222222",
          salonId: "33333333-3333-4333-8333-333333333333",
          groupId: null,
          currentStartTimeUtc: "2099-08-20T17:00:00.000Z",
          durationMinutes: 60,
        },
      },
    });
    eta.mockResolvedValue({
      version: 1,
      evaluatedAt: "2099-08-20T16:40:00.000Z",
      refreshBy: "2099-08-20T16:45:00.000Z",
      surface: "waiting",
      stale: false,
      waitRange: { earliestMinutes: 15, latestMinutes: 25 },
      partyFullyStartedRange: null,
      reasonCodes: ["ETA_FRESH_PLAN"],
      message: { en: "Estimated start in 15–25 minutes.", vi: "Dự kiến 15–25 phút." },
      estimateFingerprint: "a".repeat(64),
    });

    const response = await GET(new Request(
      `https://nailiq.test/api/booking/status?token=${TOKEN}`,
    ));
    const body = await response.json();
    expect(body.turnIqEta.waitRange).toEqual({ earliestMinutes: 15, latestMinutes: 25 });
    expect(JSON.stringify(body.turnIqEta)).not.toMatch(
      /bookingId|salonId|staffId|revenue|tip|queuePosition|snapshotVersion/i,
    );
    expect(inspect.mock.invocationCallOrder[0]).toBeLessThan(
      eta.mock.invocationCallOrder[0],
    );
  });

  it("returns an unscheduled waiting walk-in without treating the valid link as expired", async () => {
    inspect.mockResolvedValue({
      ok: true,
      inspection: {
        action: "status",
        scopeKind: "booking_own",
        epoch: 1,
        expiresAt: "2099-08-20T19:00:00.000Z",
        booking: {
          status: "waiting",
          startTimeUtc: null,
          endTimeUtc: null,
          serviceName: "Manicure",
          staffName: null,
          salonSlug: "qa-salon",
          salonName: "QA Salon",
          salonTimezone: "America/Los_Angeles",
          scheduleModel: "single",
          sequenceReceipt: null,
        },
        context: {
          bookingId: "22222222-2222-4222-8222-222222222222",
          salonId: "33333333-3333-4333-8333-333333333333",
          serviceId: "44444444-4444-4444-8444-444444444444",
          staffId: null,
          durationMinutes: null,
          timezone: "America/Los_Angeles",
          currentStartTimeUtc: null,
          currentEndTimeUtc: null,
          groupId: null,
          isGroupOrganizer: false,
        },
        group: null,
      },
    });

    const response = await GET(new Request(
      `https://nailiq.test/api/booking/status?token=${TOKEN}`,
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      code: "valid",
      booking: {
        status: "waiting",
        startTimeUtc: null,
        endTimeUtc: null,
      },
      turnIqEta: null,
    });
    expect(eta).not.toHaveBeenCalled();
  });

  it("fails closed without leaking dependency details", async () => {
    inspect.mockResolvedValue({ ok: false, code: "management_unavailable" });
    const response = await GET(new Request(
      `https://nailiq.test/api/booking/status?token=${TOKEN}`,
    ));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: "management_unavailable" });
    expect(eta).not.toHaveBeenCalled();
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
