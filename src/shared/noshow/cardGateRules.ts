/**
 * Admin-configurable rules for WHO is asked to leave a card on file.
 *
 * The card-on-file gate used to hardcode "new customer OR any 1 prior no-show OR
 * high risk". Salons want control: some don't want to gate new customers, some
 * want to forgive the first no-show (ask only after 2–3). These rules drive BOTH
 * the client pre-booking gate (resolveNoShowCardRequirement) and the server
 * decision (noShowCardDecision) through the SAME pure functions, so the two can
 * never diverge (a divergence would cancel a booking at card-save time).
 *
 * Defaults reproduce the historical behavior exactly: all triggers on, after the
 * 1st no-show.
 */
export type CardGateRules = {
  /** Ask first-time customers for a card. */
  requireNewCustomer: boolean;
  /** Ask customers with prior no-shows for a card. */
  requirePriorNoShow: boolean;
  /** How many prior no-shows trigger the card (only when requirePriorNoShow). */
  minNoShowCount: number;
  /** Ask high-risk bookings (AI risk ≥ threshold) for a card. Server-only — the
   *  risk score doesn't exist pre-booking, so the client gate ignores it. */
  requireHighRisk: boolean;
};

type RuleRow = {
  noshow_require_new_customer?: boolean | null;
  noshow_require_prior_noshow?: boolean | null;
  noshow_min_noshow_count?: number | null;
  noshow_require_high_risk?: boolean | null;
};

/** Parse rules from a `salons` row, with backward-compatible defaults (all on,
 *  after the 1st no-show). NULL/undefined → default-on. */
export function parseCardGateRules(row: RuleRow | null | undefined): CardGateRules {
  const n = Number(row?.noshow_min_noshow_count);
  return {
    requireNewCustomer: row?.noshow_require_new_customer !== false,
    requirePriorNoShow: row?.noshow_require_prior_noshow !== false,
    minNoShowCount: Number.isFinite(n) && n >= 1 ? Math.round(n) : 1,
    requireHighRisk: row?.noshow_require_high_risk !== false,
  };
}

/** History-only gate (what the CLIENT can know pre-booking: new + no-show count). */
export function cardRequiredByHistory(
  opts: { isNew: boolean; noShowCount: number },
  rules: CardGateRules,
): boolean {
  if (rules.requireNewCustomer && opts.isNew) return true;
  if (rules.requirePriorNoShow && opts.noShowCount >= rules.minNoShowCount) return true;
  return false;
}

/** Full gate = history rules PLUS the server-only high-risk trigger. Always a
 *  superset of the client gate, so the server never requires LESS than the
 *  client showed. */
export function cardRequiredFull(
  opts: { isNew: boolean; noShowCount: number; highRisk: boolean },
  rules: CardGateRules,
): boolean {
  if (cardRequiredByHistory(opts, rules)) return true;
  if (rules.requireHighRisk && opts.highRisk) return true;
  return false;
}
