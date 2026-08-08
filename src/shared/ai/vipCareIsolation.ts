type VipRelationshipInput = {
  manualVipIds: Iterable<string>;
  spendProfileIds: Iterable<string>;
  bookingProfileIds: Iterable<string>;
  squareVisitProfileIds: Iterable<string>;
};

/**
 * `client_profiles.is_vip` is currently global, while VIP Care runs per salon.
 * A global VIP flag alone must never make a customer eligible for outreach from
 * an unrelated tenant. Require a durable relationship to this salon first.
 */
export function selectSalonRelatedManualVipIds(
  input: VipRelationshipInput,
): Set<string> {
  const related = new Set([
    ...input.spendProfileIds,
    ...input.bookingProfileIds,
    ...input.squareVisitProfileIds,
  ].filter(Boolean));

  return new Set(
    [...input.manualVipIds].filter((profileId) => related.has(profileId)),
  );
}
