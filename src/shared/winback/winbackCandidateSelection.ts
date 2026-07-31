/**
 * Pure candidate selection for the win-back agent.
 *
 * Kept free of Supabase and `server-only` so the two rules that decide who the
 * agent contacts can be unit-tested directly.
 */

export type WinbackCandidate = {
  phone: string;
  name: string;
  email: string | null;
  visits: number;
  lastVisit: string;
  noShows: number;
  usualService: string | null;
};

/** Row shape returned by the `winback_candidates` RPC. */
export type WinbackCandidateRow = {
  client_phone?: unknown;
  client_name?: unknown;
  client_email?: unknown;
  visits?: unknown;
  last_visit?: unknown;
  no_shows?: unknown;
  usual_service?: unknown;
};

/**
 * How long an unreachable candidate is left alone before the agent tries again.
 *
 * Long enough that a customer is not reconsidered every hour, short enough that
 * an email address or a completed A2P registration is picked up within a week.
 */
export const WINBACK_UNREACHABLE_BACKOFF_DAYS = 7;

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

/**
 * Resolve the address to contact a lapsed customer on.
 *
 * The `winback_candidates` RPC sources `client_email` from `bookings.client_email`
 * alone. A customer whose history came from Square has no booking row, so that
 * column is empty even when `client_profiles.email` holds a real address — the
 * agent then resolves "no channel" at an email-only salon and skips someone it
 * could have reached. Production 2026-07-31: one Hi-Lite Head Spa customer was
 * skipped 166 times in 7 days for exactly this reason, with a valid email and
 * marketing consent on file the whole time.
 */
export function pickCandidateEmail(
  bookingEmail: unknown,
  profileEmail: unknown,
): string | null {
  const fromBooking = str(bookingEmail).trim();
  if (fromBooking) return fromBooking;
  const fromProfile = str(profileEmail).trim();
  return fromProfile || null;
}

/**
 * Turn RPC rows into contactable candidates.
 *
 * Two exclusions apply, both keyed on phone:
 *  - `suggestedPhones` — contacted within the dedupe window, don't pester.
 *  - `unreachablePhones` — skipped for "no channel" inside the backoff window.
 *    Without this the agent re-evaluates and re-logs the same unreachable
 *    customer on every run, forever.
 */
export function selectWinbackCandidates(
  rows: WinbackCandidateRow[],
  opts: {
    suggestedPhones: Set<string>;
    unreachablePhones: Set<string>;
    profileEmailByPhone: Map<string, string>;
    limit: number;
  },
): WinbackCandidate[] {
  const out: WinbackCandidate[] = [];
  if (opts.limit <= 0) return out;

  for (const row of rows) {
    const phone = str(row.client_phone);
    if (!phone) continue;
    if (opts.suggestedPhones.has(phone)) continue;
    if (opts.unreachablePhones.has(phone)) continue;

    out.push({
      phone,
      name: str(row.client_name) || "there",
      email: pickCandidateEmail(row.client_email, opts.profileEmailByPhone.get(phone)),
      visits: num(row.visits),
      lastVisit: str(row.last_visit),
      noShows: num(row.no_shows),
      usualService: str(row.usual_service) || null,
    });
    if (out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Phones skipped for "no channel" recently enough to still be backed off.
 *
 * Reads the same `ai_actions_log` rows the agent already writes, so no new
 * table or column is needed to remember the decision.
 */
export function collectUnreachablePhones(
  skipRows: Array<{ payload?: unknown }>,
): Set<string> {
  const phones = new Set<string>();
  for (const row of skipRows) {
    const payload = row.payload;
    if (!payload || typeof payload !== "object") continue;
    const phone = str((payload as Record<string, unknown>).phone).trim();
    if (phone) phones.add(phone);
  }
  return phones;
}
