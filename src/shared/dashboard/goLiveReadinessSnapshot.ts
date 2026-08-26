import { createHash } from "node:crypto";
import type {
  GoLiveAttestationEvent,
  GoLiveAttestationKey,
} from "@/shared/dashboard/goLiveAttestations";

type SnapshotMaterial = {
  slug: string;
  name: string | null;
  address: string | null;
  salonPhone: string | null;
  timezone: unknown;
  openingHours: unknown;
  bookingClosedDates?: string[];
  profileComplete: boolean;
  email: string | null;
  emailVerified: boolean;
  emailLinksEnabled: boolean;
  phoneOtpEnabled: boolean;
  cancellationPolicy?: unknown;
  defaultNotificationLocale?: unknown;
  paymentProvider?: unknown;
  voiceAiEnabled?: boolean;
  activeServices: Array<{
    id: string;
    priceCents: number | null;
    durationMinutes: number | null;
  }>;
  activeStaffCount: number;
  /** Omitted for legacy salons so their existing approval hash is unchanged. */
  guidedSetupEnabled?: true;
  staffAccessSignature?: Array<{
    staffId: string;
    jobRole: string | null;
    userId: string | null;
    membershipRole: string | null;
    accessActive: boolean | null;
  }>;
  serviceCapabilitySignature?: Array<{
    staffId: string;
    serviceId: string;
  }>;
  publicServiceSignature?: Array<{
    serviceId: string;
    name: string;
    description: string | null;
    priceCents: number | null;
    priceType: string;
    priceMaxCents: number | null;
    durationMinutes: number | null;
    bufferMinutes: number;
    totalMinutes: number;
  }>;
  publicStaffSignature?: Array<{
    staffId: string;
    name: string;
    jobRole: string | null;
  }>;
  publicSalonPresentation?: {
    brandColor: string;
    currencyCode: string;
    taxLines: Array<{
      name: string;
      rate: number;
      enabled: boolean;
    }>;
  };
  availabilityConfiguration?: {
    bookingLeadMinutes: number;
    resourcesEnabled: boolean;
    staffSelectionEnabled: boolean;
    staffShiftSignature: Array<{
      staffId: string;
      dayOfWeek: string;
      startTime: string;
      endTime: string;
      breakStartTime: string | null;
      breakEndTime: string | null;
    }>;
  };
  unsupportedPublicCatalogSignature?: {
    addOns: Array<{
      serviceId: string;
      name: string;
      description: string | null;
      priceCents: number | null;
      priceType: string;
      priceMaxCents: number | null;
      durationMinutes: number | null;
      bufferMinutes: number;
      addonTiming: string;
    }>;
    combos: Array<{
      comboId: string;
      name: string;
      description: string | null;
      serviceIds: string[];
      priceCents: number;
      discountCents: number;
      durationMinutes: number;
    }>;
    promotions: Array<{
      promotionId: string;
      name: string;
      startsAt: string;
      endsAt: string;
      discountType: string;
      discountValue: number;
      appliesTo: string;
      daysOfWeek: number[] | null;
      timeStart: string | null;
      timeEnd: string | null;
    }>;
  };
  groupBookingEnabled?: boolean;
  groupTogetherThresholdMinutes?: number | null;
  noShowGroupWholeParty?: boolean | null;
  services: Array<{
    id: string;
    priceCents: number | null;
    durationMinutes: number | null;
  }>;
  activeStaffIds: string[];
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

export function createGoLiveReadinessSnapshotHash(
  material: SnapshotMaterial,
): string {
  const normalized = {
    ...material,
    name: material.name?.trim() || null,
    address: material.address?.trim() || null,
    salonPhone: material.salonPhone?.trim() || null,
    email: material.email?.trim().toLowerCase() || null,
    ...(material.bookingClosedDates
      ? { bookingClosedDates: [...material.bookingClosedDates].sort() }
      : {}),
    ...(material.staffAccessSignature
      ? {
          staffAccessSignature: [...material.staffAccessSignature].sort((a, b) =>
            a.staffId.localeCompare(b.staffId),
          ),
        }
      : {}),
    ...(material.serviceCapabilitySignature
      ? {
          serviceCapabilitySignature: [
            ...material.serviceCapabilitySignature,
          ].sort((a, b) =>
            `${a.serviceId}:${a.staffId}`.localeCompare(
              `${b.serviceId}:${b.staffId}`,
            ),
          ),
        }
      : {}),
    ...(material.publicServiceSignature
      ? {
          publicServiceSignature: material.publicServiceSignature
            .map((service) => ({
              ...service,
              description: service.description?.trim() || null,
            }))
            .sort((a, b) => a.serviceId.localeCompare(b.serviceId)),
        }
      : {}),
    ...(material.publicStaffSignature
      ? {
          publicStaffSignature: [...material.publicStaffSignature].sort((a, b) =>
            a.staffId.localeCompare(b.staffId),
          ),
        }
      : {}),
    ...(material.availabilityConfiguration
      ? {
          availabilityConfiguration: {
            ...material.availabilityConfiguration,
            staffShiftSignature: [
              ...material.availabilityConfiguration.staffShiftSignature,
            ].sort((a, b) =>
              `${a.staffId}:${a.dayOfWeek}`.localeCompare(
                `${b.staffId}:${b.dayOfWeek}`,
              ),
            ),
          },
        }
      : {}),
    ...(material.unsupportedPublicCatalogSignature
      ? {
          unsupportedPublicCatalogSignature: {
            addOns: material.unsupportedPublicCatalogSignature.addOns
              .map((addOn) => ({
                ...addOn,
                description: addOn.description?.trim() || null,
              }))
              .sort((a, b) => a.serviceId.localeCompare(b.serviceId)),
            combos: material.unsupportedPublicCatalogSignature.combos
              .map((combo) => ({
                ...combo,
                description: combo.description?.trim() || null,
                serviceIds: [...combo.serviceIds].sort(),
              }))
              .sort((a, b) => a.comboId.localeCompare(b.comboId)),
            promotions: material.unsupportedPublicCatalogSignature.promotions
              .map((promotion) => ({
                ...promotion,
                daysOfWeek: promotion.daysOfWeek
                  ? [...promotion.daysOfWeek].sort((a, b) => a - b)
                  : null,
              }))
              .sort((a, b) =>
                a.promotionId.localeCompare(b.promotionId),
              ),
          },
        }
      : {}),
    services: [...material.services].sort((a, b) => a.id.localeCompare(b.id)),
    activeStaffIds: [...material.activeStaffIds].sort(),
  };
  return createHash("sha256")
    .update(JSON.stringify(stable(normalized)))
    .digest("hex");
}

const prerequisiteKeys = [
  "hours_confirmed",
  "otp_policy_confirmed",
  "live_rehearsal_completed",
] as const satisfies readonly GoLiveAttestationKey[];

/**
 * Final approval covers both the technical configuration and the exact human
 * prerequisite events the owner reviewed. Revoking or re-attesting any
 * prerequisite therefore makes the previous owner approval stale.
 */
export function createGoLiveApprovalSnapshotHash(
  technicalSnapshotHash: string,
  latestEvents: GoLiveAttestationEvent[],
): string {
  const prerequisites = prerequisiteKeys.map((key) => {
    const event = latestEvents.find((candidate) => candidate.checkKey === key);
    return {
      key,
      id: event?.id ?? null,
      action: event?.action ?? null,
    };
  });

  return createHash("sha256")
    .update(JSON.stringify({ technicalSnapshotHash, prerequisites }))
    .digest("hex");
}
