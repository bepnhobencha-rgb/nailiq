import { createHash } from "node:crypto";
import type {
  GoLiveAttestationEvent,
  GoLiveAttestationKey,
} from "@/shared/dashboard/goLiveAttestations";

type SnapshotMaterial = {
  name: string | null;
  address: string | null;
  salonPhone: string | null;
  timezone: unknown;
  openingHours: unknown;
  profileComplete: boolean;
  email: string | null;
  emailVerified: boolean;
  emailLinksEnabled: boolean;
  phoneOtpEnabled: boolean;
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
