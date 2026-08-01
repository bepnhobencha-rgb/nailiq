import { describe, expect, it } from "vitest";

import {
  collectUnreachablePhones,
  pickCandidateEmail,
  selectWinbackCandidates,
  WINBACK_UNREACHABLE_BACKOFF_DAYS,
} from "@/shared/winback/winbackCandidateSelection";

const row = (over: Record<string, unknown> = {}) => ({
  client_phone: "19099387025",
  client_name: "Brooke Davis",
  client_email: null,
  visits: 4,
  last_visit: "2026-05-02T18:00:00.000Z",
  no_shows: 0,
  usual_service: "Hi-Lite Royal",
  ...over,
});

const empty = {
  suggestedPhones: new Set<string>(),
  unreachablePhones: new Set<string>(),
  profileEmailByPhone: new Map<string, string>(),
  limit: 10,
};

describe("pickCandidateEmail", () => {
  it("prefers the booking email when one exists", () => {
    expect(pickCandidateEmail("booked@example.com", "profile@example.com")).toBe(
      "booked@example.com",
    );
  });

  it("falls back to the client profile email", () => {
    // The production regression: winback_candidates sources client_email from
    // bookings only, so a Square-sourced customer looked unreachable.
    expect(pickCandidateEmail(null, "profile@example.com")).toBe(
      "profile@example.com",
    );
  });

  it("treats blank and whitespace-only values as absent", () => {
    expect(pickCandidateEmail("", "  ")).toBeNull();
    expect(pickCandidateEmail("   ", "profile@example.com")).toBe(
      "profile@example.com",
    );
  });

  it("returns null when neither source has an address", () => {
    expect(pickCandidateEmail(null, undefined)).toBeNull();
  });
});

describe("selectWinbackCandidates", () => {
  it("recovers the email from the profile map", () => {
    const [candidate] = selectWinbackCandidates([row()], {
      ...empty,
      profileEmailByPhone: new Map([["19099387025", "brooke@example.com"]]),
    });
    expect(candidate.email).toBe("brooke@example.com");
    expect(candidate.phone).toBe("19099387025");
    expect(candidate.visits).toBe(4);
    expect(candidate.usualService).toBe("Hi-Lite Royal");
  });

  it("skips a phone contacted inside the dedupe window", () => {
    expect(
      selectWinbackCandidates([row()], {
        ...empty,
        suggestedPhones: new Set(["19099387025"]),
      }),
    ).toEqual([]);
  });

  it("skips a phone still inside the unreachable backoff window", () => {
    // Without this the same customer was re-evaluated once an hour: 166
    // skipped_no_channel rows for one person over 7 days on production.
    expect(
      selectWinbackCandidates([row()], {
        ...empty,
        unreachablePhones: new Set(["19099387025"]),
      }),
    ).toEqual([]);
  });

  it("still returns a backed-off customer once an email is known and the window has passed", () => {
    const [candidate] = selectWinbackCandidates([row()], {
      ...empty,
      unreachablePhones: new Set(),
      profileEmailByPhone: new Map([["19099387025", "brooke@example.com"]]),
    });
    expect(candidate.email).toBe("brooke@example.com");
  });

  it("honours the limit and drops rows with no phone", () => {
    const rows = [
      row({ client_phone: "1" }),
      row({ client_phone: "" }),
      row({ client_phone: "2" }),
      row({ client_phone: "3" }),
    ];
    const picked = selectWinbackCandidates(rows, { ...empty, limit: 2 });
    expect(picked.map((c) => c.phone)).toEqual(["1", "2"]);
  });

  it("returns nothing when the limit is zero", () => {
    expect(selectWinbackCandidates([row()], { ...empty, limit: 0 })).toEqual([]);
  });

  it("defaults a missing name rather than addressing an empty string", () => {
    const [candidate] = selectWinbackCandidates([row({ client_name: null })], empty);
    expect(candidate.name).toBe("there");
  });
});

describe("collectUnreachablePhones", () => {
  it("reads phones out of skipped_no_channel payloads", () => {
    const phones = collectUnreachablePhones([
      { payload: { phone: "19099387025", reason: "email_only_but_no_email_on_file" } },
      { payload: { phone: "12065550111", reason: "no_channel" } },
      { payload: { phone: "19099387025", reason: "no_channel" } },
    ]);
    expect(phones).toEqual(new Set(["19099387025", "12065550111"]));
  });

  it("ignores malformed or empty payloads", () => {
    expect(
      collectUnreachablePhones([
        { payload: null },
        { payload: "not-an-object" },
        { payload: {} },
        { payload: { phone: "  " } },
        {},
      ]),
    ).toEqual(new Set());
  });
});

describe("WINBACK_UNREACHABLE_BACKOFF_DAYS", () => {
  it("is long enough to stop hourly retries and short enough to recover within a week", () => {
    expect(WINBACK_UNREACHABLE_BACKOFF_DAYS).toBe(7);
  });
});
