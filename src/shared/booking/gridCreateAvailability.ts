export type GridCreateService = {
  id: string;
  durationMinutes: number;
  isAddon: boolean;
};

export type GridCreateCapability = {
  staffId: string;
  serviceId: string;
};

/**
 * Find the shortest customer-facing MAIN service each staff member can accept.
 *
 * `capabilityRows === null` is the product's existing "all staff can perform
 * every service" fallback. Add-ons are deliberately excluded: a five-minute
 * concurrent eye mask is not a standalone appointment and must never make a
 * near-closing grid cell look bookable.
 */
export function buildMinimumServiceMinutesByStaff(args: {
  staffIds: readonly string[];
  services: readonly GridCreateService[];
  capabilityRows: readonly GridCreateCapability[] | null;
}): Record<string, number | null> {
  const mainServices = args.services.filter((service) => {
    const duration = Math.round(Number(service.durationMinutes));
    return !service.isAddon && Number.isFinite(duration) && duration >= 1;
  });

  const allowedByStaff =
    args.capabilityRows === null
      ? null
      : args.capabilityRows.reduce<Map<string, Set<string>>>((map, row) => {
          const allowed = map.get(row.staffId) ?? new Set<string>();
          allowed.add(row.serviceId);
          map.set(row.staffId, allowed);
          return map;
        }, new Map());

  return Object.fromEntries(
    args.staffIds.map((staffId) => {
      const allowed = allowedByStaff?.get(staffId);
      const durations = mainServices
        .filter(
          (service) =>
            allowedByStaff === null || allowed?.has(service.id) === true,
        )
        .map((service) => Math.round(Number(service.durationMinutes)));
      return [staffId, durations.length > 0 ? Math.min(...durations) : null];
    }),
  );
}

/**
 * A click-to-create preview is truthful only when at least one main service can
 * finish before closing. The final cleanup buffer is intentionally excluded,
 * matching the shared booking closing-time rule.
 */
export function canOfferGridCreateStart(args: {
  staffIsActive: boolean;
  startMinutes: number;
  openMinutes?: number | null;
  closeMinutes?: number | null;
  minimumServiceMinutes?: number | null;
}): boolean {
  if (!args.staffIsActive) return false;

  const start = Math.round(Number(args.startMinutes));
  if (!Number.isFinite(start)) return false;
  if (args.openMinutes != null && start < args.openMinutes) return false;
  if (args.closeMinutes != null && start >= args.closeMinutes) return false;

  // `undefined` keeps backwards compatibility for callers that do not yet
  // provide catalog context. `null` explicitly means this staff has no
  // bookable main service.
  if (args.minimumServiceMinutes === null) return false;
  if (
    args.closeMinutes != null &&
    args.minimumServiceMinutes !== undefined
  ) {
    const minimum = Math.round(Number(args.minimumServiceMinutes));
    if (!Number.isFinite(minimum) || minimum < 1) return false;
    if (start + minimum > args.closeMinutes) return false;
  }

  return true;
}
