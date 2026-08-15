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
