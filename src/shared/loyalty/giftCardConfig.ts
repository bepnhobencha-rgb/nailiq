/**
 * Compatibility constant for retired legacy Gift Card surfaces.
 *
 * The purchase endpoint (`/api/gift-card/purchase`) minted a fully-redeemable
 * voucher with NO charge, public + unauthenticated — so anyone hitting
 * `/<slug>/gift` could mint free spendable value. It is hard-off here, NOT
 * behind a per-salon flag, because a flag-on salon would still have the
 * free-mint hole.
 *
 * The old public route and page are now permanently unavailable, so changing
 * this constant cannot restore them. A future paid Square-only product flow
 * must use a new reviewed route and the durable create -> completed payment ->
 * activation receipt chain; it must never insert local spendable voucher value.
 */
export const GIFT_CARD_PURCHASE_ENABLED = false;

/**
 * The legacy action mutations are also permanently unavailable. Keep this
 * compatibility constant false; existing historical rows remain read-only.
 */
export const GIFT_CARD_VALUE_MUTATIONS_ENABLED = false;
