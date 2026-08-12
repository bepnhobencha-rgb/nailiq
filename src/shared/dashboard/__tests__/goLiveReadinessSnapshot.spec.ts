import { describe, expect, it } from "vitest";
import {
  createGoLiveApprovalSnapshotHash,
  createGoLiveReadinessSnapshotHash,
} from "@/shared/dashboard/goLiveReadinessSnapshot";
import type { GoLiveAttestationEvent } from "@/shared/dashboard/goLiveAttestations";

const material = {
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
  cancellationPolicy: { en: "Policy EN", vi: "Policy VI" },
  defaultNotificationLocale: "en",
  services: [
    { id: "service-b", priceCents: 5000, durationMinutes: 60 },
    { id: "service-a", priceCents: 3000, durationMinutes: 30 },
  ],
  activeStaffIds: ["staff-b", "staff-a"],
};

describe("go-live readiness snapshot", () => {
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
