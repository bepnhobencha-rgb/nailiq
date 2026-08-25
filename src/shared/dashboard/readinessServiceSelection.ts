export type ReadinessServiceCandidate = {
  id: string;
  priceCents: number | null;
  durationMinutes: number | null;
  isAddon: boolean;
};

/**
 * Legacy readiness historically counted every non-deleted service, including
 * add-ons. Preserve that exact flag-OFF contract; only the QA Guided pilot
 * narrows readiness to main services that customers can select first.
 */
export function selectReadinessServices(
  services: ReadinessServiceCandidate[],
  guidedSetupEnabled: boolean,
): Array<Omit<ReadinessServiceCandidate, "isAddon">> {
  return services.flatMap(({ isAddon, ...service }) =>
    guidedSetupEnabled && isAddon ? [] : [service],
  );
}
