import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
  submitCapacityRescueRequestChecked: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/publicClient", () => ({
  createPublicClient: mocks.createPublicClient,
}));
vi.mock("@/shared/booking/submitCapacityRescueRequest", () => ({
  submitCapacityRescueRequestChecked: mocks.submitCapacityRescueRequestChecked,
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPublicClient.mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: { id: "00000000-0000-4000-8000-000000000010" },
              error: null,
            }),
          })),
        })),
      })),
    });
  });

  it.each(["", "not-an-email", "jane@"])(
    "rejects missing or malformed email before calling Supabase: %j",
    async (clientEmail) => {
      await expect(
        submitPublicWaitlistEntry({ ...BASE, clientEmail }),
      ).rejects.toThrow("invalid_email");
    },
  );

  it("returns the typed slot-available result without claiming a waitlist insert", async () => {
    mocks.submitCapacityRescueRequestChecked.mockResolvedValue({
      outcome: "slot_available",
      slotLabel: "2:00 PM",
    });
    await expect(
      submitPublicWaitlistEntry({
        ...BASE,
        clientEmail: "jane@example.com",
      }),
    ).resolves.toEqual({ outcome: "slot_available", slotLabel: "2:00 PM" });
  });

  it("returns a durable receipt only for a verified unavailable slot", async () => {
    mocks.submitCapacityRescueRequestChecked.mockResolvedValue({
      outcome: "created",
      availability: "slot_unavailable",
      receipt: {
        requestId: "00000000-0000-4000-8000-000000000099",
        status: "waiting",
        createdNew: true,
      },
    });
    await expect(
      submitPublicWaitlistEntry({
        ...BASE,
        clientEmail: "jane@example.com",
      }),
    ).resolves.toEqual({
      outcome: "created",
      waitlistId: "00000000-0000-4000-8000-000000000099",
    });
  });

  it("returns fail-closed truth when availability cannot be verified", async () => {
    mocks.submitCapacityRescueRequestChecked.mockResolvedValue({
      outcome: "availability_unverified",
    });
    await expect(
      submitPublicWaitlistEntry({
        ...BASE,
        clientEmail: "jane@example.com",
      }),
    ).resolves.toEqual({ outcome: "availability_unverified" });
  });
});
