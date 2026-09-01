import type { ServiceCategory } from "@/shared/booking/serviceCategory";

export const SERVICE_RESOURCE_KINDS = [
  "station",
  "chair",
  "bed",
  "backwash",
  "room",
  "other",
] as const;

export type ServiceResourceKind = (typeof SERVICE_RESOURCE_KINDS)[number];
export type ServiceResourceRequirementMode =
  | "salon_default"
  | "none"
  | "specific";

export function normalizeServiceResourceRequirement(input: {
  mode?: unknown;
  kinds?: unknown;
}): {
  mode: ServiceResourceRequirementMode;
  kinds: ServiceResourceKind[];
} | null {
  const mode: ServiceResourceRequirementMode =
    input.mode === "none" || input.mode === "specific"
      ? input.mode
      : "salon_default";
  const kinds = Array.isArray(input.kinds)
    ? [...new Set(input.kinds.filter(
        (value): value is ServiceResourceKind =>
          typeof value === "string" &&
          SERVICE_RESOURCE_KINDS.includes(value as ServiceResourceKind),
      ))]
    : [];
  if (mode === "specific" && kinds.length === 0) return null;
  return { mode, kinds: mode === "specific" ? kinds : [] };
}

type ComparableService = {
  id?: string;
  category: ServiceCategory;
  price_cents: number;
  duration_minutes: number;
  prep_minutes: number;
  buffer_minutes: number;
};

export type ServiceSetupGuidance = {
  durationMinutes: number;
  prepMinutes: number;
  bufferMinutes: number;
  suggestedResourceKinds: ServiceResourceKind[];
  priceAnchorCents: number | null;
  priceWarning: "unusually_low" | "unusually_high" | null;
  basis: "salon_menu" | "safe_default";
};

const CATEGORY_DEFAULTS: Record<
  ServiceCategory,
  Pick<
    ServiceSetupGuidance,
    "durationMinutes" | "prepMinutes" | "bufferMinutes" | "suggestedResourceKinds"
  >
> = {
  manicure: { durationMinutes: 45, prepMinutes: 5, bufferMinutes: 10, suggestedResourceKinds: ["station", "chair"] },
  pedicure: { durationMinutes: 60, prepMinutes: 5, bufferMinutes: 10, suggestedResourceKinds: ["chair"] },
  acrylic: { durationMinutes: 75, prepMinutes: 5, bufferMinutes: 10, suggestedResourceKinds: ["station", "chair"] },
  gel: { durationMinutes: 60, prepMinutes: 5, bufferMinutes: 10, suggestedResourceKinds: ["station", "chair"] },
  dip_powder: { durationMinutes: 60, prepMinutes: 5, bufferMinutes: 10, suggestedResourceKinds: ["station", "chair"] },
  removal: { durationMinutes: 30, prepMinutes: 0, bufferMinutes: 5, suggestedResourceKinds: ["station", "chair"] },
  waxing: { durationMinutes: 30, prepMinutes: 5, bufferMinutes: 10, suggestedResourceKinds: ["room", "bed"] },
  eyelashes: { durationMinutes: 90, prepMinutes: 10, bufferMinutes: 15, suggestedResourceKinds: ["bed", "room"] },
  other: { durationMinutes: 45, prepMinutes: 5, bufferMinutes: 10, suggestedResourceKinds: [] },
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

/**
 * Deterministic Coco setup guidance. It never calls an AI/provider and never
 * writes data. Salon-owned comparable services are preferred; safe category
 * defaults are used only when the salon has no comparable history.
 */
export function buildServiceSetupGuidance(input: {
  serviceId?: string | null;
  category: ServiceCategory;
  currentPriceCents: number | null;
  peers: readonly ComparableService[];
  availableResourceKinds: readonly ServiceResourceKind[];
}): ServiceSetupGuidance {
  const comparable = input.peers.filter(
    (service) =>
      service.id !== input.serviceId && service.category === input.category,
  );
  const fallback = CATEGORY_DEFAULTS[input.category];
  const priceAnchorCents = median(comparable.map((service) => service.price_cents));
  const duration = median(comparable.map((service) => service.duration_minutes));
  const prep = median(comparable.map((service) => service.prep_minutes));
  const buffer = median(comparable.map((service) => service.buffer_minutes));
  const available = new Set(input.availableResourceKinds);
  const suggestedResourceKinds = fallback.suggestedResourceKinds.filter((kind) =>
    available.has(kind),
  );
  const price = input.currentPriceCents;
  const priceWarning =
    price != null && priceAnchorCents != null && priceAnchorCents > 0
      ? price < priceAnchorCents * 0.5
        ? "unusually_low"
        : price > priceAnchorCents * 2
          ? "unusually_high"
          : null
      : null;

  return {
    durationMinutes: duration ?? fallback.durationMinutes,
    prepMinutes: prep ?? fallback.prepMinutes,
    bufferMinutes: buffer ?? fallback.bufferMinutes,
    suggestedResourceKinds,
    priceAnchorCents,
    priceWarning,
    basis: comparable.length > 0 ? "salon_menu" : "safe_default",
  };
}
