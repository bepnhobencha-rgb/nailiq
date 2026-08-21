/**
 * Gift-card PURCHASE is disabled until payment collection is wired.
 *
 * The purchase endpoint (`/api/gift-card/purchase`) minted a fully-redeemable
 * voucher with NO charge, public + unauthenticated — so anyone hitting
 * `/<slug>/gift` could mint free spendable value. It is hard-off here, NOT
 * behind a per-salon flag, because a flag-on salon would still have the
 * free-mint hole.
 *
 * To ship gift cards for real: wire a Square/Stripe charge that must succeed
 * BEFORE the voucher insert, then flip this to `true` in the same change.
 * Redemption of any already-issued gift voucher is unaffected (0 exist on prod).
 */
export const GIFT_CARD_PURCHASE_ENABLED = false;

/**
 * Manual issuance/redemption also changes spendable value. Keep both OFF until
 * a tenant-bound atomic ledger RPC records authorization, value movement, and
 * an exact replay result. Existing read-only history remains viewable.
 */
export const GIFT_CARD_VALUE_MUTATIONS_ENABLED = false;
