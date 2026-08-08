import { describe, expect, it } from "vitest";

import {
  decideOutcomeResolution,
  outcomeDeadline,
  sortLatestActionFirst,
} from "@/shared/ai/outcomeAttribution";

describe("outcome attribution", () => {
  it("processes the latest customer touch first", () => {
    const rows = sortLatestActionFirst([
      { id: "old", created_at: "2026-07-01T00:00:00Z" },
      { id: "new", created_at: "2026-07-08T00:00:00Z" },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["new", "old"]);
  });

  it("attributes one unclaimed booking to the latest eligible action", () => {
    expect(
      decideOutcomeResolution({
        agent: "first_visit",
        sentAt: "2026-07-01T00:00:00Z",
        candidateBookingId: "booking-1",
        bookingAlreadyAttributed: false,
        now: new Date("2026-07-10T00:00:00Z"),
      }),
    ).toBe("converted");
  });

  it("does not attribute the same booking twice", () => {
    expect(
      decideOutcomeResolution({
        agent: "first_visit",
        sentAt: "2026-07-01T00:00:00Z",
        candidateBookingId: "booking-1",
        bookingAlreadyAttributed: true,
        now: new Date("2026-07-10T00:00:00Z"),
      }),
    ).toBe("pending");
  });

  it("uses each agent's full measurement window", () => {
    const base = {
      sentAt: "2026-07-01T00:00:00Z",
      candidateBookingId: null,
      bookingAlreadyAttributed: false,
    };
    expect(
      decideOutcomeResolution({
        ...base,
        agent: "rebook",
        now: new Date("2026-07-15T00:00:00Z"),
      }),
    ).toBe("no_conversion");
    expect(
      decideOutcomeResolution({
        ...base,
        agent: "first_visit",
        now: new Date("2026-07-15T00:00:00Z"),
      }),
    ).toBe("pending");
  });

  it("returns an exact attribution deadline for booking queries", () => {
    expect(
      outcomeDeadline("winback", "2026-07-01T00:00:00Z").toISOString(),
    ).toBe("2026-07-22T00:00:00.000Z");
    expect(
      outcomeDeadline("vip_care", "2026-07-01T00:00:00Z").toISOString(),
    ).toBe("2026-07-31T00:00:00.000Z");
  });
});
