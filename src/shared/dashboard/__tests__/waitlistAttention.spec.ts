import { describe, expect, it } from "vitest";

import {
  summarizeWaitlistAttention,
  waitlistAgeMinutes,
} from "../waitlistAttention";

describe("waitlist attention", () => {
  const observedAt = "2026-08-11T18:10:00.000Z";

  it("reports waiting, claimed, and the oldest unresolved age", () => {
    expect(
      summarizeWaitlistAttention(
        [
          {
            status: "waiting",
            createdAt: "2026-08-11T17:58:20.000Z",
          },
          {
            status: "waiting",
            createdAt: "2026-08-11T18:06:00.000Z",
          },
          {
            status: "claimed",
            createdAt: "2026-08-11T17:40:00.000Z",
          },
          {
            status: "notified",
            createdAt: "2026-08-11T17:30:00.000Z",
          },
        ],
        observedAt,
      ),
    ).toEqual({
      total: 4,
      waiting: 2,
      claimed: 1,
      oldestWaitingMinutes: 11,
    });
  });

  it("does not invent an age for invalid timestamps", () => {
    expect(waitlistAgeMinutes("not-a-date", observedAt)).toBeNull();
    expect(
      summarizeWaitlistAttention(
        [{ status: "waiting", createdAt: "not-a-date" }],
        observedAt,
      ),
    ).toEqual({
      total: 1,
      waiting: 1,
      claimed: 0,
      oldestWaitingMinutes: null,
    });
  });

  it("clamps small clock skew to zero instead of showing negative wait", () => {
    expect(
      waitlistAgeMinutes("2026-08-11T18:11:00.000Z", observedAt),
    ).toBe(0);
  });
});
