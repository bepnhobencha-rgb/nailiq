import { describe, expect, it } from "vitest";

import { bookingSequenceDraftStorageKey } from "@/shared/booking/bookingSequenceDraft";

describe("bookingSequenceDraftStorageKey", () => {
  it("keeps the same identity binding and separates a changed customer without PII", async () => {
    const salonId = "11111111-1111-4111-8111-111111111111";
    const first = await bookingSequenceDraftStorageKey({ salonId, phone: "+1 604 555 0199" });
    const replay = await bookingSequenceDraftStorageKey({ salonId, phone: "16045550199" });
    const changed = await bookingSequenceDraftStorageKey({ salonId, phone: "+1 604 555 0111" });
    expect(replay).toBe(first);
    expect(changed).not.toBe(first);
    expect(first).not.toContain("16045550199");
  });
});
