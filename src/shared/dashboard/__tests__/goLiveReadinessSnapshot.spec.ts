import { describe, expect, it } from "vitest";
import {
  createGoLiveApprovalSnapshotHash,
  createGoLiveReadinessSnapshotHash,
} from "@/shared/dashboard/goLiveReadinessSnapshot";
import type { GoLiveAttestationEvent } from "@/shared/dashboard/goLiveAttestations";

const material = {
  slug: "tech-nails",
  name: "Tech Nails",
  address: "123 Main St",
  salonPhone: "+16045550123",
  timezone: "America/Vancouver",
  openingHours: {
    mon: { open: "09:00", close: "18:00", closed: false },
  },
  profileComplete: true,
  email: "HELLO@example.com",
  emailVerified: true,
  emailLinksEnabled: true,
  phoneOtpEnabled: true,
  activeServices: [
    { id: "service-b", priceCents: 5000, durationMinutes: 60 },
    { id: "service-a", priceCents: 3000, durationMinutes: 30 },
  ],
  activeStaffCount: 2,
  services: [
    { id: "service-b", priceCents: 5000, durationMinutes: 60 },
    { id: "service-a", priceCents: 3000, durationMinutes: 30 },
  ],
  activeStaffIds: ["staff-b", "staff-a"],
};

describe("go-live readiness snapshot", () => {
  it("preserves the historical flag-off readiness hash vector", () => {
    expect(createGoLiveReadinessSnapshotHash(material)).toBe(
      "bfccaf0654758cc64290fa0384aa7ce63c8ea70c64c5e1c7a5175ff8750fee1f",
    );
  });

  it("is stable across object and list ordering", () => {
    const reordered = {
      ...material,
      openingHours: {
        mon: { closed: false, close: "18:00", open: "09:00" },
      },
      services: [...material.services].reverse(),
      activeStaffIds: [...material.activeStaffIds].reverse(),
      email: "hello@example.com",
    };

    expect(createGoLiveReadinessSnapshotHash(reordered)).toBe(
      createGoLiveReadinessSnapshotHash(material),
    );
  });

  it("changes when an operationally relevant value changes", () => {
    const changed = {
      ...material,
      services: material.services.map((service) =>
        service.id === "service-a"
          ? { ...service, priceCents: service.priceCents + 100 }
          : service,
      ),
    };

    expect(createGoLiveReadinessSnapshotHash(changed)).not.toBe(
      createGoLiveReadinessSnapshotHash(material),
    );
  });

  it("starts a new approval snapshot when the Guided Setup pilot is enabled", () => {
    expect(
      createGoLiveReadinessSnapshotHash({
        ...material,
        guidedSetupEnabled: true,
      }),
    ).not.toBe(createGoLiveReadinessSnapshotHash(material));
  });

  it("binds owner approval to closed dates, staff access, and service capabilities", () => {
    const guided = {
      ...material,
      guidedSetupEnabled: true as const,
      bookingClosedDates: ["2026-12-25"],
      staffAccessSignature: [
        {
          staffId: "staff-a",
          jobRole: "owner",
          userId: null,
          membershipRole: null,
          accessActive: null,
        },
      ],
      serviceCapabilitySignature: [
        { staffId: "staff-a", serviceId: "service-a" },
      ],
      publicServiceSignature: [
        {
          serviceId: "service-a",
          name: "Manicure",
          description: "Classic care",
          priceCents: 3000,
          priceType: "fixed",
          priceMaxCents: null,
          durationMinutes: 30,
          bufferMinutes: 10,
          totalMinutes: 40,
        },
      ],
      publicStaffSignature: [
        { staffId: "staff-a", name: "Anh", jobRole: "owner" },
      ],
      publicSalonPresentation: {
        brandColor: "#d4af37",
        currencyCode: "CAD",
        taxLines: [{ name: "GST", rate: 0.05, enabled: true }],
      },
      availabilityConfiguration: {
        bookingLeadMinutes: 30,
        resourcesEnabled: false,
        staffSelectionEnabled: true,
        staffShiftSignature: [
          {
            staffId: "staff-a",
            dayOfWeek: "mon",
            startTime: "09:00",
            endTime: "17:00",
            breakStartTime: "12:00",
            breakEndTime: "12:30",
          },
        ],
      },
      unsupportedPublicCatalogSignature: {
        addOns: [],
        combos: [],
        promotions: [],
      },
    };

    expect(
      createGoLiveReadinessSnapshotHash({
        ...guided,
        serviceCapabilitySignature: [
          ...guided.serviceCapabilitySignature,
          { staffId: "staff-b", serviceId: "service-b" },
        ],
      }),
    ).not.toBe(createGoLiveReadinessSnapshotHash(guided));

    for (const unsupportedPublicCatalogSignature of [
      {
        ...guided.unsupportedPublicCatalogSignature,
        addOns: [
          {
            serviceId: "addon-1",
            name: "Gel removal",
            description: null,
            priceCents: 1000,
            priceType: "fixed",
            priceMaxCents: null,
            durationMinutes: 15,
            bufferMinutes: 0,
            addonTiming: "sequential",
          },
        ],
      },
      {
        ...guided.unsupportedPublicCatalogSignature,
        combos: [
          {
            comboId: "combo-1",
            name: "Hands and feet",
            description: null,
            serviceIds: ["service-a"],
            priceCents: 7000,
            discountCents: 500,
            durationMinutes: 90,
          },
        ],
      },
      {
        ...guided.unsupportedPublicCatalogSignature,
        promotions: [
          {
            promotionId: "promo-1",
            name: "Weekday offer",
            startsAt: "2026-09-01T00:00:00.000Z",
            endsAt: "2026-09-30T23:59:59.000Z",
            discountType: "percent",
            discountValue: 1000,
            appliesTo: "all",
            daysOfWeek: [1, 2, 3],
            timeStart: null,
            timeEnd: null,
          },
        ],
      },
    ]) {
      expect(
        createGoLiveReadinessSnapshotHash({
          ...guided,
          unsupportedPublicCatalogSignature,
        }),
      ).not.toBe(createGoLiveReadinessSnapshotHash(guided));
    }

    const promotion = {
      promotionId: "promo-1",
      name: "Weekday offer",
      startsAt: "2026-09-01T00:00:00.000Z",
      endsAt: "2026-09-30T23:59:59.000Z",
      discountType: "percent",
      discountValue: 1000,
      appliesTo: "all",
      daysOfWeek: [1, 2, 3],
      timeStart: null,
      timeEnd: null,
    };
    for (const changedPromotion of [
      { ...promotion, startsAt: "2026-08-31T00:00:00.000Z" },
      { ...promotion, endsAt: "2026-10-01T23:59:59.000Z" },
    ]) {
      expect(
        createGoLiveReadinessSnapshotHash({
          ...guided,
          unsupportedPublicCatalogSignature: {
            ...guided.unsupportedPublicCatalogSignature,
            promotions: [changedPromotion],
          },
        }),
      ).not.toBe(createGoLiveReadinessSnapshotHash(guided));
    }

    for (const availabilityConfiguration of [
      { ...guided.availabilityConfiguration, resourcesEnabled: true },
      { ...guided.availabilityConfiguration, bookingLeadMinutes: 60 },
      { ...guided.availabilityConfiguration, staffSelectionEnabled: false },
      {
        ...guided.availabilityConfiguration,
        staffShiftSignature:
          guided.availabilityConfiguration.staffShiftSignature.map((shift) => ({
            ...shift,
            breakStartTime: "13:00",
            breakEndTime: "13:30",
          })),
      },
    ]) {
      expect(
        createGoLiveReadinessSnapshotHash({
          ...guided,
          availabilityConfiguration,
        }),
      ).not.toBe(createGoLiveReadinessSnapshotHash(guided));
    }

    expect(
      createGoLiveReadinessSnapshotHash({
        ...guided,
        publicServiceSignature: guided.publicServiceSignature.map((service) => ({
          ...service,
          bufferMinutes: service.bufferMinutes + 5,
          totalMinutes: service.totalMinutes + 5,
        })),
      }),
    ).not.toBe(createGoLiveReadinessSnapshotHash(guided));

    expect(
      createGoLiveReadinessSnapshotHash({
        ...guided,
        publicSalonPresentation: {
          ...guided.publicSalonPresentation,
          brandColor: "#123456",
        },
      }),
    ).not.toBe(createGoLiveReadinessSnapshotHash(guided));

    expect(
      createGoLiveReadinessSnapshotHash({
        ...guided,
        publicSalonPresentation: {
          ...guided.publicSalonPresentation,
          taxLines: [{ name: "GST", rate: 0.06, enabled: true }],
        },
      }),
    ).not.toBe(createGoLiveReadinessSnapshotHash(guided));

    expect(
      createGoLiveReadinessSnapshotHash({
        ...guided,
        publicServiceSignature: guided.publicServiceSignature.map((service) =>
          service.serviceId === "service-a"
            ? { ...service, description: "Updated public description" }
            : service,
        ),
      }),
    ).not.toBe(createGoLiveReadinessSnapshotHash(guided));

    expect(
      createGoLiveReadinessSnapshotHash({
        ...guided,
        publicStaffSignature: guided.publicStaffSignature.map((staff) =>
          staff.staffId === "staff-a" ? { ...staff, name: "Mai" } : staff,
        ),
      }),
    ).not.toBe(createGoLiveReadinessSnapshotHash(guided));
  });

  it("invalidates owner approval when a prerequisite event changes", () => {
    const event = {
      id: "hours-event-1",
      checkKey: "hours_confirmed",
      action: "attest",
      evidenceNote: "Owner confirmed business hours.",
      actorRole: "owner",
      readinessSnapshotHash: null,
      createdAt: "2026-07-28T00:00:00.000Z",
    } satisfies GoLiveAttestationEvent;
    const technicalHash = createGoLiveReadinessSnapshotHash(material);

    expect(createGoLiveApprovalSnapshotHash(technicalHash, [event])).not.toBe(
      createGoLiveApprovalSnapshotHash(technicalHash, [
        { ...event, id: "hours-event-2" },
      ]),
    );
  });
});
