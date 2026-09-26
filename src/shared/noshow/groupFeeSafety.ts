/** These codes are returned before a new payment dispatch is permitted. */
export function groupFeeNeedsSafetyReview(reason: string | null | undefined): boolean {
  return reason === "group_fee_consent_invalid"
    || reason === "group_fee_amount_exceeds_cap"
    || reason === "group_fee_provider_binding_changed"
    || reason === "group_fee_snapshot_invalid"
    || reason === "group_fee_consent_changed";
}
