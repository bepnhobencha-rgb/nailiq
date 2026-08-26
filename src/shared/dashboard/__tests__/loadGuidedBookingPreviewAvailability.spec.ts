import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadGuidedBookingPreview: vi.fn(),
  getAvailableTimeSlotsStrict: vi.fn(),
}));

vi.mock("@/shared/dashboard/loadGuidedBookingPreview", () => ({
  loadGuidedBookingPreview: mocks.loadGuidedBookingPreview,
}));
vi.mock("@/shared/booking/getAvailableTimeSlots", () => ({
  getAvailableTimeSlotsStrict: mocks.getAvailableTimeSlotsStrict,
}));

import { loadGuidedBookingPreviewAvailability } from "@/shared/dashboard/loadGuidedBookingPreviewAvailability";

function previewData() {
  return {
    slug: "qa-salon",
    salon: {
      id: "salon-1",
      name: "QA Salon",
      address: "123 QA Street",
      phone: "+16045550123",
      timezone: "America/Vancouver",
      brandColor: "#C9A227",
      openingHoursRaw: {
        mon: { open: "09:00", close: "18:00", closed: false },
      },
      bookingClosedDates: ["2026-09-02"],
      bookingLeadMinutes: 30,
      resourcesEnabled: false,
      staffSelectionEnabled: true,
    },
    previewWindow: {
      firstDateYmd: "2026-09-01",
      lastDateYmd: "2026-10-30",
    },
    services: [
      {
        id: "service-1",
        name: "Gel Manicure",
        description: null,
        durationMinutes: 45,
        bufferMinutes: 10,
        totalMinutes: 55,
        priceDisplay: "$45.00",
      },
      {
        id: "service-2",
        name: "Pedicure",
        description: null,
        durationMinutes: 30,
        bufferMinutes: 0,
        totalMinutes: 30,
        priceDisplay: "$40.00",
      },
    ],
    staff: [
      { id: "staff-1", name: "Jenny", jobRole: "nail_tech" },
      { id: "staff-2", name: "Mai", jobRole: "nail_tech" },
    ],
    capabilityRows: [
      { staffId: "staff-1", serviceId: "service-1" },
      { staffId: "staff-2", serviceId: "service-2" },
    ],
  };
}

const input = {
  slug: "qa-salon",
  serviceId: "service-1",
  staffId: "any",
  dateYmd: "2026-09-03",
};

describe("loadGuidedBookingPreviewAvailability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadGuidedBookingPreview.mockResolvedValue({
      ok: true,
      data: previewData(),
    });
    mocks.getAvailableTimeSlotsStrict.mockResolvedValue({
      ok: true,
      slots: [{ label: "9:00 AM", available: true }],
    });
  });

  it.each(["unauthorized", "disabled", "unavailable"] as const)(
    "preserves the authenticated preview %s denial",
    async (reason) => {
      mocks.loadGuidedBookingPreview.mockResolvedValue({ ok: false, reason });
      await expect(
        loadGuidedBookingPreviewAvailability(input),
      ).resolves.toEqual({ ok: false, reason });
      expect(mocks.getAvailableTimeSlotsStrict).not.toHaveBeenCalled();
    },
  );

  it("fails closed before slot reads for resource-mode salons", async () => {
    const data = previewData();
    data.salon.resourcesEnabled = true;
    mocks.loadGuidedBookingPreview.mockResolvedValue({ ok: true, data });

    await expect(
      loadGuidedBookingPreviewAvailability(input),
    ).resolves.toEqual({
      ok: false,
      reason: "resource_mode_not_proven",
    });
    expect(mocks.getAvailableTimeSlotsStrict).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, serviceId: "foreign-service" },
    { ...input, staffId: "foreign-staff" },
    { ...input, staffId: "staff-2" },
  ] as const)("rejects a tampered or incapable selection", async (request) => {
    await expect(
      loadGuidedBookingPreviewAvailability(request),
    ).resolves.toEqual({ ok: false, reason: "invalid_selection" });
    expect(mocks.getAvailableTimeSlotsStrict).not.toHaveBeenCalled();
  });

  it("rejects a specific staff selection when the public flow hides that choice", async () => {
    const data = previewData();
    data.salon.staffSelectionEnabled = false;
    mocks.loadGuidedBookingPreview.mockResolvedValue({ ok: true, data });

    await expect(
      loadGuidedBookingPreviewAvailability({ ...input, staffId: "staff-1" }),
    ).resolves.toEqual({ ok: false, reason: "invalid_selection" });
    expect(mocks.getAvailableTimeSlotsStrict).not.toHaveBeenCalled();
  });

  it.each([
    "2026-02-30",
    "2026-08-31",
    "2026-10-31",
    " 2026-09-03",
  ])("rejects invalid or out-of-window date %s", async (dateYmd) => {
    await expect(
      loadGuidedBookingPreviewAvailability({ ...input, dateYmd }),
    ).resolves.toEqual({ ok: false, reason: "invalid_date" });
    expect(mocks.getAvailableTimeSlotsStrict).not.toHaveBeenCalled();
  });

  it("uses only eligible staff and exact service timing in the strict read", async () => {
    await expect(
      loadGuidedBookingPreviewAvailability(input),
    ).resolves.toEqual({
      ok: true,
      dateYmd: "2026-09-03",
      slots: [{ label: "9:00 AM", available: true }],
    });
    expect(mocks.getAvailableTimeSlotsStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: "salon-1",
        staffId: "any",
        staffList: [
          { id: "staff-1", name: "Jenny", job_role: "nail_tech" },
        ],
        serviceDurationMinutes: 55,
        trailingBufferMinutes: 10,
        shortestServiceMinutes: 30,
        leadMinutes: 30,
        timezone: "America/Vancouver",
      }),
    );
    const call = mocks.getAvailableTimeSlotsStrict.mock.calls[0][0];
    expect(call.closedDateYmdSet).toEqual(new Set(["2026-09-02"]));
  });

  it("returns unavailable instead of slots when any strict read fails", async () => {
    mocks.getAvailableTimeSlotsStrict.mockResolvedValue({
      ok: false,
      reason: "unavailable",
    });
    await expect(
      loadGuidedBookingPreviewAvailability(input),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
