"use server";

/**
 * loadPartyCardsAction — Party Card Dashboard data loader.
 *
 * Returns group bookings for today + 7 days that have a Party Link, grouped
 * as PartyCard objects for the receptionist's Party Card panel.
 *
 * Security contract:
 *   - Caller must be an authenticated salon member (getDashboardWriteClient).
 *   - Only party links for ctx.salon.id are returned (multi-tenant boundary).
 *   - member_phone is NEVER selected; it stays in the DB only.
 *   - estimatedRevenueCents is null unless ALL slots have a price_cents value.
 */

import * as Sentry from "@sentry/nextjs";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  buildPartyCard,
  partyCardWindowUtc,
  type PartyCard,
  type RawClaim,
  type RawPartyLink,
} from "@/shared/dashboard/partyCardHelpers";

// Re-export types so callers only need one import.
export type { PartyCard, PartyCardSlot } from "@/shared/dashboard/partyCardHelpers";

// ─── Result type ──────────────────────────────────────────────────

export type LoadPartyCardsResult =
  | { ok: true; cards: PartyCard[] }
  | { ok: false; error: "unauthorized" | "server_error" };

// ─── Server action ────────────────────────────────────────────────

export async function loadPartyCardsAction(
  slug: string,
): Promise<LoadPartyCardsResult> {
  // 1. Auth — validate caller is a salon member.
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const salonId = ctx.salon.id;
  const tz =
    typeof ctx.salon.timezone === "string" && ctx.salon.timezone.trim()
      ? ctx.salon.timezone.trim()
      : "UTC";

  // 2. Service-role client for cross-table join (bypasses RLS; caller
  //    is already validated as a salon member above).
  let db: ReturnType<typeof createServiceRoleClient>;
  try {
    db = createServiceRoleClient();
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "[nailiq] loadPartyCardsAction: service-role client unavailable — " +
          "Party Card panel will be empty. Set SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    Sentry.captureException(err, { extra: { salonId } });
    return { ok: true, cards: [] }; // Graceful: success with empty list
  }

  const { start: windowStart, end: windowEnd } = partyCardWindowUtc();
  const now = new Date();

  // 3. Fetch party links for this salon (multi-tenant filter).
  const { data: partyLinks, error: linkErr } = await db
    .from("party_links")
    .select("id, group_id, token, mode, expires_at")
    .eq("salon_id", salonId);

  if (linkErr) {
    Sentry.captureException(linkErr, { extra: { salonId } });
    return { ok: false, error: "server_error" };
  }
  if (!partyLinks || partyLinks.length === 0) {
    return { ok: true, cards: [] };
  }

  const partyLinkIds = partyLinks.map((pl) => pl.id);
  const partyLinkMap = new Map(
    partyLinks.map((pl) => [pl.id, pl as RawPartyLink]),
  );

  // 4. Fetch claims with booking details.
  //    Deliberately omits member_phone — phone privacy contract.
  const { data: claims, error: claimsErr } = await db
    .from("party_link_claims")
    .select(
      `
      id,
      party_link_id,
      booking_id,
      member_name,
      claimed_at,
      bookings (
        start_time_utc,
        end_time_utc,
        price_cents,
        services!bookings_service_id_fkey ( name ),
        staff!bookings_staff_id_fkey ( name )
      )
    `,
    )
    .in("party_link_id", partyLinkIds);

  if (claimsErr) {
    Sentry.captureException(claimsErr, { extra: { salonId } });
    return { ok: false, error: "server_error" };
  }
  if (!claims || claims.length === 0) {
    return { ok: true, cards: [] };
  }

  // 5. Filter to date window and group by party_link_id.
  const claimsByLink = new Map<string, RawClaim[]>();
  for (const raw of claims) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = (raw.bookings as any) as { start_time_utc: string | null } | null;
    const startIso = b?.start_time_utc;
    if (!startIso) continue;

    const startMs = new Date(startIso).getTime();
    if (startMs < windowStart.getTime() || startMs >= windowEnd.getTime()) {
      continue;
    }

    const list = claimsByLink.get(raw.party_link_id) ?? [];
    list.push({
      id: raw.id,
      party_link_id: raw.party_link_id,
      booking_id: raw.booking_id,
      member_name: raw.member_name,
      claimed_at: raw.claimed_at,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bookings: (raw.bookings as any) as RawClaim["bookings"],
    });
    claimsByLink.set(raw.party_link_id, list);
  }

  // 6. Build a PartyCard per group, sorted by group start time.
  const cards: PartyCard[] = [];
  for (const [partyLinkId, linkClaims] of claimsByLink) {
    const pl = partyLinkMap.get(partyLinkId);
    if (!pl || linkClaims.length === 0) continue;
    cards.push(buildPartyCard(pl, linkClaims, tz, now));
  }

  cards.sort((a, b) => a.groupStartUtcIso.localeCompare(b.groupStartUtcIso));

  return { ok: true, cards };
}
