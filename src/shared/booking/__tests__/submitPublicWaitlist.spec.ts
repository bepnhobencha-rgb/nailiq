import { describe, expect, it } from "vitest";

import { submitPublicWaitlistEntry } from "@/shared/booking/submitPublicWaitlist";

const BASE = {
  shopSlug: "test-salon",
  serviceId: "00000000-0000-4000-8000-000000000001",
  preferredSlotLabel: "3:00 PM",
  bookingDateYmd: "2030-05-05",
  staffId: "any",
  clientName: "Jane Customer",
  clientPhone: "7788680738",
  source: "slot_unavailable" as const,
};

describe("submitPublicWaitlistEntry email requirement", () => {
  it.each(["", "not-an-email", "jane@"])(
    "rejects missing or malformed email before calling Supabase: %j",
    async (clientEmail) => {
      await expect(
        submitPublicWaitlistEntry({ ...BASE, clientEmail }),
      ).rejects.toThrow("invalid_email");
    },
  );
});
