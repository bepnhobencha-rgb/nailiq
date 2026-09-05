import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadBookingServicesForSalonSlug: vi.fn(),
  getAvailableTimeSlotsStrict: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/shared/booking/loadBookingServices", () => ({
  loadBookingServicesForSalonSlug: mocks.loadBookingServicesForSalonSlug,
}));
vi.mock("@/shared/booking/getAvailableTimeSlots", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/shared/booking/getAvailableTimeSlots")
  >()),
  getAvailableTimeSlotsStrict: mocks.getAvailableTimeSlotsStrict,
}));

import { verifyIndividualWaitlistAvailability } from "@/shared/booking/verifyIndividualWaitlistAvailability";
import { computeTimeSlots } from "@/shared/booking/getAvailableTimeSlots";

const IDS = {
  salon: "00000000-0000-4000-8000-000000000001",
  service: "00000000-0000-4000-8000-000000000002",
};
const staff = Array.from({ length: 7 }, (_, index) => ({
  id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
  name: `Tech ${index + 1}`,
  job_role: "nail_tech",
}));
const resources = Array.from({ length: 7 }, (_, index) => ({
  id: `00000000-0000-4000-8000-0000000002${String(index).padStart(2, "0")}`,
  name: `Bed ${index + 1}`,
  kind: "bed" as const,
  displayOrder: index,
}));

const bookingData = {
  canonicalSlug: "hilite-anaheim",
  services: [
    {
      id: IDS.service,
      name: "Hi Lite VVIP",
      durationMinutes: 100,
      prepMinutes: 0,
      bufferMinutes: 10,
      totalMinutes: 110,
      resourceRequirementMode: "specific",
      requiredResourceKinds: ["bed"],
    },
  ],
  addOns: [],
  combos: [],
  staff,
  capabilityRows: null,
  resources,
  proofComplete: true,
  hasActivePromotions: false,
  salon: {
    id: IDS.salon,
    timezone: "America/Los_Angeles",
    opening_hours: {
      thu: { open: "09:00", close: "18:00", closed: false },
    },
    booking_closed_dates: [],
    bookingLeadMinutes: 15,
    resourcesEnabled: true,
  },
};

const input = {
  salonSlug: "hilite-anaheim",
  salonId: IDS.salon,
  serviceId: IDS.service,
  staffId: null,
  bookingDateYmd: "2030-09-05",
  preferredSlotLabel: "12:00 PM",
};

describe("verifyIndividualWaitlistAvailability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadBookingServicesForSalonSlug.mockResolvedValue(bookingData);
  });

  it("rejects a false waitlist when two of seven staff and beds can serve noon", async () => {
    mocks.getAvailableTimeSlotsStrict.mockResolvedValue({
      ok: true,
      slots: [{ label: "12:00 PM", available: true }],
    });

    await expect(verifyIndividualWaitlistAvailability(input)).resolves.toEqual({
      outcome: "slot_available",
      slotLabel: "12:00 PM",
    });
    expect(mocks.getAvailableTimeSlotsStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        staffList: staff,
        requiresResource: true,
        eligibleResourceIds: resources.map((resource) => resource.id),
        serviceDurationMinutes: 110,
        trailingBufferMinutes: 10,
      }),
    );
  });

  it("allows waitlist creation only after the exact slot is verified full", async () => {
    mocks.getAvailableTimeSlotsStrict.mockResolvedValue({
      ok: true,
      slots: [{ label: "12:00 PM", available: false }],
    });
    await expect(verifyIndividualWaitlistAvailability(input)).resolves.toEqual({
      outcome: "slot_unavailable",
    });
  });

  it("fails closed when occupancy, shift, or resource truth is unavailable", async () => {
    mocks.getAvailableTimeSlotsStrict.mockResolvedValue({
      ok: false,
      reason: "unavailable",
    });
    await expect(verifyIndividualWaitlistAvailability(input)).resolves.toEqual({
      outcome: "availability_unverified",
    });
  });

  it("fails closed when the requested label cannot be matched to the canonical grid", async () => {
    mocks.getAvailableTimeSlotsStrict.mockResolvedValue({
      ok: true,
      slots: [],
    });
    await expect(verifyIndividualWaitlistAvailability(input)).resolves.toEqual({
      outcome: "availability_unverified",
    });
  });

  it("rejects a whole-day waitlist when any verified slot remains", async () => {
    mocks.getAvailableTimeSlotsStrict.mockResolvedValue({
      ok: true,
      slots: [
        { label: "1:45 PM", available: false },
        { label: "2:00 PM", available: true },
      ],
    });
    await expect(
      verifyIndividualWaitlistAvailability({
        ...input,
        preferredSlotLabel: null,
      }),
    ).resolves.toEqual({ outcome: "slot_available", slotLabel: "2:00 PM" });
  });
});

describe("False Waitlist capacity fixtures", () => {
  const openingHours = Object.fromEntries(
    ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((day) => [
      day,
      { open: "09:00", close: "18:00", closed: false },
    ]),
  );
  const selectedDate = new Date(2030, 8, 5, 12, 0, 0);
  const start = new Date(2030, 8, 5, 12, 0, 0).toISOString();
  const end = new Date(2030, 8, 5, 13, 10, 0).toISOString();
  const staffList = staff.map(({ id, name, job_role }) => ({
    id,
    name,
    job_role,
  }));
  const base = {
    openingHoursRaw: openingHours,
    selectedDate,
    staffId: "any",
    staffList,
    serviceDurationMinutes: 110,
    trailingBufferMinutes: 10,
    nowMs: new Date(2030, 8, 5, 8, 0, 0).getTime(),
    requiresResource: true,
    eligibleResourceIds: resources.map((resource) => resource.id),
  };

  it("replays Hi-Lite: noon remains bookable with five of seven staff and beds occupied", () => {
    const slots = computeTimeSlots({
      ...base,
      occupancy: staff.slice(0, 5).map((person, index) => ({
        staff_id: person.id,
        resource_id: resources[index]!.id,
        start_time_utc: start,
        end_time_utc: end,
      })),
    });
    expect(slots.find((slot) => slot.label === "12:00 PM")?.available).toBe(
      true,
    );
  });

  it("marks noon unavailable when every staff member is occupied", () => {
    const slots = computeTimeSlots({
      ...base,
      occupancy: staff.map((person, index) => ({
        staff_id: person.id,
        resource_id: resources[index]!.id,
        start_time_utc: start,
        end_time_utc: end,
      })),
    });
    expect(slots.find((slot) => slot.label === "12:00 PM")?.available).toBe(
      false,
    );
  });

  it("marks noon unavailable when every eligible bed is occupied", () => {
    const slots = computeTimeSlots({
      ...base,
      occupancy: resources.map((resource) => ({
        staff_id: staff[0]!.id,
        resource_id: resource.id,
        start_time_utc: start,
        end_time_utc: end,
      })),
    });
    expect(slots.find((slot) => slot.label === "12:00 PM")?.available).toBe(
      false,
    );
  });
});
