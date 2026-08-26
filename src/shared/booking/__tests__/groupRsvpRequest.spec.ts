import { beforeEach, describe, expect, it, vi } from "vitest";

import { stableBookingManagementRequestId } from "../bookingManagementRequestId";
import { groupRsvpManagementIntent } from "../groupRsvpRequest";

const values = new Map<string, string>();

describe("group RSVP browser replay privacy", () => {
  beforeEach(() => {
    values.clear();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  it("stores no member, organizer, phone, or email material for a stable RSVP retry", async () => {
    const intent = groupRsvpManagementIntent(
      "confirm",
      "11111111-1111-4111-8111-111111111111",
    );
    await stableBookingManagementRequestId(intent);
    const stored = [...values.entries()].map(([key, value]) => `${key}:${value}`).join("\n");
    expect(stored).not.toContain("Mai Nguyen");
    expect(stored).not.toContain("Organizer Tran");
    expect(stored).not.toContain("+16045550123");
    expect(stored).not.toContain("mai@example.test");
    expect(stored).not.toContain(intent.token);
    expect(stored).toContain('"material":""');
  });
});
