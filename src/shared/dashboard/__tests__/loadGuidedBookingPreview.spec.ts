import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDashboardWriteClient: vi.fn(),
  isCocoSetupExperienceVisible: vi.fn(),
  resolvePublicBookingPage: vi.fn(),
  salonToday: vi.fn(),
  salonDateOffset: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getDashboardWriteClient,
}));
vi.mock("@/shared/dashboard/cocoSetupActivation", () => ({
  isCocoSetupExperienceVisible: mocks.isCocoSetupExperienceVisible,
}));
vi.mock("@/shared/booking/resolvePublicBookingPage", () => ({
  resolvePublicBookingPage: mocks.resolvePublicBookingPage,
}));
vi.mock("@/shared/lib/salonTime", () => ({
  salonToday: mocks.salonToday,
  salonDateOffset: mocks.salonDateOffset,
}));

import { loadGuidedBookingPreview } from "@/shared/dashboard/loadGuidedBookingPreview";

type MemberRole = "owner" | "admin" | "senior" | "receptionist" | "nail_tech";

function member(role: MemberRole, salonId = "salon-1") {
  return {
    kind: "member",
    role,
    userId: "user-1",
    salon: {
      id: salonId,
      slug: "qa-salon",
      feature_flags: { guided_admin_setup_enabled: true },
    },
  };
}

function publicPayload(salonId = "salon-1") {
  return {
    status: "ok",
    normalizedSlug: "qa-salon",
    load: {
      salon: {
        id: salonId,
        name: "QA Salon",
        address: "123 QA Street",
        salonPhone: "+16045550123",
        timezone: "America/Vancouver",
        acceptingBookings: true,
        brandColor: "#C9A227",
        themeMode: "dark",
        opening_hours: { mon: { open: "09:00", close: "18:00", closed: false } },
        booking_closed_dates: ["2026-09-02"],
        bookingLeadMinutes: 30,
        resourcesEnabled: false,
        staffSelectionEnabled: true,
        groupBookingEnabled: false,
        taxLines: [{ name: "GST", rate: 0.05, enabled: true }],
      },
      services: [
        {
          id: "service-1",
          name: "Gel Manicure",
          description: "Public description",
          durationMinutes: 45,
          bufferMinutes: 10,
          totalMinutes: 55,
          priceDisplay: "$45.00",
          isPopular: true,
          promoId: null as string | null,
        },
      ],
      staff: [
        { id: "staff-1", name: "Jenny", job_role: "nail_tech" },
      ],
      capabilityRows: [
        { staff_id: "staff-1", service_id: "service-1" },
      ],
      addOns: [],
      combos: [],
      proofComplete: true,
      hasActivePromotions: false,
    },
  };
}

describe("loadGuidedBookingPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDashboardWriteClient.mockResolvedValue(member("owner"));
    mocks.isCocoSetupExperienceVisible.mockResolvedValue(true);
    mocks.resolvePublicBookingPage.mockResolvedValue(publicPayload());
    mocks.salonToday.mockReturnValue("2026-09-01");
    mocks.salonDateOffset.mockReturnValue("2026-10-30");
  });

  it("rejects an invalid slug before resolving a caller or public data", async () => {
    await expect(loadGuidedBookingPreview("   ")).resolves.toEqual({
      ok: false,
      reason: "unauthorized",
    });
    expect(mocks.getDashboardWriteClient).not.toHaveBeenCalled();
    expect(mocks.resolvePublicBookingPage).not.toHaveBeenCalled();
  });

  it.each(["senior", "receptionist", "nail_tech"] as const)(
    "rejects a %s before resolving public data",
    async (role) => {
      mocks.getDashboardWriteClient.mockResolvedValue(member(role));

      await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
        ok: false,
        reason: "unauthorized",
      });
      expect(mocks.isCocoSetupExperienceVisible).not.toHaveBeenCalled();
      expect(mocks.resolvePublicBookingPage).not.toHaveBeenCalled();
    },
  );

  it("rejects an anonymous or foreign caller", async () => {
    mocks.getDashboardWriteClient.mockResolvedValue(null);

    await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
      ok: false,
      reason: "unauthorized",
    });
    expect(mocks.resolvePublicBookingPage).not.toHaveBeenCalled();
  });

  it("fails closed when caller authorization throws", async () => {
    mocks.getDashboardWriteClient.mockRejectedValue(new Error("auth unavailable"));

    await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(mocks.resolvePublicBookingPage).not.toHaveBeenCalled();
  });

  it("fails closed when the effective platform plus tenant flag is disabled", async () => {
    mocks.isCocoSetupExperienceVisible.mockResolvedValue(false);

    await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(mocks.resolvePublicBookingPage).not.toHaveBeenCalled();
  });

  it("fails closed when the effective flag resolver throws", async () => {
    mocks.isCocoSetupExperienceVisible.mockRejectedValue(
      new Error("platform state unavailable"),
    );

    await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(mocks.resolvePublicBookingPage).not.toHaveBeenCalled();
  });

  it.each(["error", "not_found", "reserved", "redirect"] as const)(
    "keeps the preview unavailable when public resolution returns %s",
    async (status) => {
      mocks.resolvePublicBookingPage.mockResolvedValue({ status });

      await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
        ok: false,
        reason: "unavailable",
      });
    },
  );

  it("fails closed when public payload resolution throws", async () => {
    mocks.resolvePublicBookingPage.mockRejectedValue(
      new Error("public catalog unavailable"),
    );

    await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("fails closed when the public payload belongs to another salon", async () => {
    mocks.resolvePublicBookingPage.mockResolvedValue(publicPayload("salon-2"));

    await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it.each([
    ["services", []],
    ["staff", []],
    ["capabilityRows", null],
    ["capabilityRows", []],
  ] as const)(
    "fails closed when the public %s payload is incomplete",
    async (field, value) => {
      const payload = publicPayload();
      payload.load[field] = value as never;
      mocks.resolvePublicBookingPage.mockResolvedValue(payload);

      await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
        ok: false,
        reason: "unavailable",
      });
    },
  );

  it("fails closed when capability rows are cross-catalog or leave a service uncovered", async () => {
    const crossCatalog = publicPayload();
    crossCatalog.load.capabilityRows = [
      { staff_id: "foreign-staff", service_id: "service-1" },
    ];
    mocks.resolvePublicBookingPage.mockResolvedValue(crossCatalog);

    await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });

    const uncovered = publicPayload();
    uncovered.load.services.push({
      ...uncovered.load.services[0],
      id: "service-2",
      name: "Pedicure",
    });
    mocks.resolvePublicBookingPage.mockResolvedValue(uncovered);
    await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it.each(["addOns", "combos"] as const)(
    "keeps unsupported public %s catalogs unapproved",
    async (field) => {
      const payload = publicPayload();
      payload.load[field].push({ id: `${field}-1` } as never);
      mocks.resolvePublicBookingPage.mockResolvedValue(payload);

      await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
        ok: false,
        reason: "unavailable",
      });
    },
  );

  it("keeps an enabled group-booking surface unapproved by the individual preview", async () => {
    const payload = publicPayload();
    payload.load.salon.groupBookingEnabled = true;
    mocks.resolvePublicBookingPage.mockResolvedValue(payload);

    await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("fails closed on a partial source read or any active public promotion", async () => {
    const partial = publicPayload();
    partial.load.proofComplete = false;
    mocks.resolvePublicBookingPage.mockResolvedValue(partial);
    await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });

    const promoted = publicPayload();
    promoted.load.hasActivePromotions = true;
    mocks.resolvePublicBookingPage.mockResolvedValue(promoted);
    await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });

    const promotedService = publicPayload();
    promotedService.load.services[0] = {
      ...promotedService.load.services[0],
      promoId: "promo-1",
    };
    mocks.resolvePublicBookingPage.mockResolvedValue(promotedService);
    await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("ignores add-on capability rows while proving every main service", async () => {
    const payload = publicPayload();
    payload.load.capabilityRows.push({
      staff_id: "staff-1",
      service_id: "addon-service",
    });
    mocks.resolvePublicBookingPage.mockResolvedValue(payload);

    const result = await loadGuidedBookingPreview("qa-salon");
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected preview to remain available");
    expect(result.data.capabilityRows).toEqual([
      { staffId: "staff-1", serviceId: "service-1" },
    ]);
  });

  it.each(["owner", "admin"] as const)(
    "returns only inert public display data for a same-salon %s",
    async (role) => {
      mocks.getDashboardWriteClient.mockResolvedValue(member(role));

      await expect(loadGuidedBookingPreview("qa-salon")).resolves.toEqual({
        ok: true,
        data: {
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
            taxLines: [{ name: "GST", rate: 0.05, enabled: true }],
          },
          previewWindow: {
            firstDateYmd: "2026-09-01",
            lastDateYmd: "2026-10-30",
          },
          services: [
            {
              id: "service-1",
              name: "Gel Manicure",
              description: "Public description",
              durationMinutes: 45,
              bufferMinutes: 10,
              totalMinutes: 55,
              priceDisplay: "$45.00",
            },
          ],
          staff: [
            { id: "staff-1", name: "Jenny", jobRole: "nail_tech" },
          ],
          capabilityRows: [
            { staffId: "staff-1", serviceId: "service-1" },
          ],
        },
      });
      expect(mocks.isCocoSetupExperienceVisible).toHaveBeenCalledWith(
        expect.objectContaining({ id: "salon-1" }),
      );
      expect(mocks.resolvePublicBookingPage).toHaveBeenCalledWith("qa-salon");
      const todayNowIso = mocks.salonToday.mock.calls[0]?.[1];
      const offsetNowIso = mocks.salonDateOffset.mock.calls[0]?.[2];
      expect(typeof todayNowIso).toBe("string");
      expect(offsetNowIso).toBe(todayNowIso);
    },
  );
});
