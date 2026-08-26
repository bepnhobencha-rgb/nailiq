/**
 * Wix Bookings REST client (server-only).
 *
 * Auth: per-salon account API key (stored on `wix_integrations.wix_api_key`,
 * resolved by `wix-site-id`) with a fallback to the `WIX_API_KEY` env var for
 * the original single-tenant setup. Plus a per-call `wix-site-id` header.
 * The key needs Wix Bookings **Manage** (write) scope for confirm/cancel and
 * **Read** for the query. Generated at manage.wix.com/account/api-keys.
 */
import "server-only";
import { looseServiceClient } from "./looseDb";

const READER = "https://www.wixapis.com/bookings/bookings-reader/v2/extended-bookings/query";
const WRITER = "https://www.wixapis.com/bookings/v2/bookings";

// siteId -> { key, at }. Self-service salons store their key in the DB; resolving
// it on every Wix call would add a query per request, so cache briefly. TTL keeps
// staleness bounded after a salon rotates its key in Admin Settings.
const KEY_TTL_MS = 60_000;
const keyCache = new Map<string, { key: string; at: number }>();

/**
 * Resolve the Wix API key for a site: per-salon `wix_integrations.wix_api_key`
 * first (self-service onboarding), then the `WIX_API_KEY` env var (legacy single
 * tenant). Whitespace is stripped — pasting a key into a form/env field often
 * line-wraps it, which would make `Authorization` an invalid header value.
 */
async function resolveApiKey(siteId: string): Promise<string> {
  const hit = keyCache.get(siteId);
  if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.key;

  let key = "";
  try {
    const { data } = await looseServiceClient()
      .from("wix_integrations")
      .select("wix_api_key")
      .eq("site_id", siteId)
      .maybeSingle();
    key = String((data?.wix_api_key as string) ?? "").replace(/\s+/g, "");
  } catch {
    /* DB unreachable — fall through to env */
  }
  if (!key) key = (process.env.WIX_API_KEY ?? "").replace(/\s+/g, "");
  if (!key) throw new Error(`No Wix API key for site ${siteId} (no wix_integrations.wix_api_key and no WIX_API_KEY env)`);

  keyCache.set(siteId, { key, at: Date.now() });
  return key;
}

/** Drop a cached key (call after a salon saves/rotates its key so the next call re-reads). */
export function invalidateWixKeyCache(siteId: string): void {
  keyCache.delete(siteId);
}

export type WixBooking = {
  id: string;
  status: string; // CONFIRMED | PENDING | CREATED | CANCELED | DECLINED | WAITING_LIST
  revision: string;
  externalUserId?: string;
  startDate?: string;
  endDate?: string;
  updatedDate?: string;
  bookedEntity?: {
    title?: string;
    slot?: {
      serviceId?: string;
      scheduleId?: string;
      timezone?: string;
      startDate?: string;
      endDate?: string;
      resource?: { id?: string; name?: string };
    };
  };
  contactDetails?: { firstName?: string; lastName?: string; phone?: string; email?: string };
  additionalFields?: Array<{ label?: string; value?: string }>;
};

/** Build request headers using an already-resolved key. */
function headersWithKey(siteId: string, apiKey: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: apiKey.replace(/\s+/g, ""), "wix-site-id": siteId };
}

async function post(url: string, siteId: string, body: unknown): Promise<unknown> {
  const key = await resolveApiKey(siteId);
  const res = await fetch(url, { method: "POST", headers: headersWithKey(siteId, key), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Wix ${res.status} ${url.split("/").slice(-1)[0]}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * POST to any Wix endpoint with an EXPLICIT key (not resolved from DB/env).
 * Used by the self-service admin flow to test a pasted key + list services/staff
 * BEFORE it's saved. `path` is an absolute https URL.
 */
export async function wixPostWithKey(siteId: string, apiKey: string, url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: headersWithKey(siteId, apiKey), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Wix ${res.status} ${url.split("/").slice(-1)[0]}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Pull every booking whose `updatedDate >= sinceIso`, oldest-first.
 * Wix rejects filter+cursor together, so page 1 carries filter+sort and later
 * pages send the cursor alone.
 */
export async function queryBookingsUpdatedSince(siteId: string, sinceIso: string): Promise<WixBooking[]> {
  const out: WixBooking[] = [];
  let body: unknown = {
    query: {
      filter: { updatedDate: { $gte: sinceIso } },
      sort: [{ fieldName: "updatedDate", order: "ASC" }],
      cursorPaging: { limit: 50 },
    },
  };
  for (let guard = 0; guard < 200; guard++) {
    const r = (await post(READER, siteId, body)) as {
      extendedBookings?: Array<{ booking: WixBooking }>;
      pagingMetadata?: { hasNext?: boolean; cursors?: { next?: string } };
    };
    for (const eb of r.extendedBookings ?? []) out.push(eb.booking);
    const next = r.pagingMetadata?.cursors?.next;
    if (!r.pagingMetadata?.hasNext || !next) break;
    body = { query: { cursorPaging: { limit: 50, cursor: next } } };
  }
  return out;
}

export async function getBooking(siteId: string, bookingId: string): Promise<WixBooking | null> {
  const r = (await post(READER, siteId, { query: { filter: { id: bookingId } } })) as {
    extendedBookings?: Array<{ booking: WixBooking }>;
  };
  return r.extendedBookings?.[0]?.booking ?? null;
}

/**
 * Resolve a NailIQ-origin booking by the stable external user ID supplied on
 * Create Booking. This is the provider read used after an ambiguous response;
 * it must happen before any retry decision so a lost response cannot create a
 * second Wix appointment.
 */
export async function getBookingByExternalUserId(
  siteId: string,
  externalUserId: string,
): Promise<WixBooking | null> {
  const r = (await post(READER, siteId, {
    query: { filter: { externalUserId } },
  })) as { extendedBookings?: Array<{ booking: WixBooking }> };
  const matches = (r.extendedBookings ?? [])
    .map((row) => row.booking)
    .filter((booking) => booking.externalUserId === externalUserId);
  if (matches.length > 1) throw new Error("external_user_id_ambiguous");
  return matches[0] ?? null;
}

/** Confirm a PENDING/CREATED Wix booking → CONFIRMED. Fetches the current revision first. */
export async function confirmWixBooking(siteId: string, bookingId: string): Promise<string> {
  const b = await getBooking(siteId, bookingId);
  if (!b) throw new Error("booking_not_found");
  const current = b.status.toUpperCase();
  if (current === "CONFIRMED") return current;
  if (!["PENDING", "CREATED", "WAITING_LIST"].includes(current)) {
    throw new Error(`booking_status_not_confirmable:${current}`);
  }
  const r = (await post(`${WRITER}/${bookingId}/confirm`, siteId, {
    participantNotification: { notifyParticipants: false },
    bookingId,
    revision: b.revision,
  })) as { booking?: WixBooking };
  return r.booking?.status ?? "UNKNOWN";
}

/** Cancel a Wix booking → CANCELED. Fetches the current revision first. */
export async function cancelWixBooking(siteId: string, bookingId: string): Promise<string> {
  const b = await getBooking(siteId, bookingId);
  if (!b) throw new Error("booking_not_found");
  const current = b.status.toUpperCase();
  if (current === "CANCELED" || current === "CANCELLED") return "CANCELED";
  const r = (await post(`${WRITER}/${bookingId}/cancel`, siteId, {
    participantNotification: { notifyParticipants: false },
    bookingId,
    revision: b.revision,
    // A salon-initiated cancel must bypass the customer-facing cancellation window
    // (e.g. "no cancellations within 24h"). Without this Wix returns 428
    // BOOKING_POLICY_VIOLATION and the booking stays CONFIRMED on Wix.
    flowControlSettings: { ignoreCancellationPolicy: true },
  })) as { booking?: WixBooking };
  return r.booking?.status ?? "UNKNOWN";
}

/** Decline a PENDING/CREATED Wix booking → DECLINED (the "reject request" action). */
export async function declineWixBooking(siteId: string, bookingId: string): Promise<string> {
  const b = await getBooking(siteId, bookingId);
  if (!b) throw new Error("booking_not_found");
  const current = b.status.toUpperCase();
  if (current === "DECLINED") return current;
  if (!["PENDING", "CREATED", "WAITING_LIST"].includes(current)) {
    throw new Error(`booking_status_not_declinable:${current}`);
  }
  const r = (await post(`${WRITER}/${bookingId}/decline`, siteId, {
    participantNotification: { notifyParticipants: false },
    bookingId,
    revision: b.revision,
  })) as { booking?: WixBooking };
  return r.booking?.status ?? "UNKNOWN";
}

/**
 * Create a new booking on Wix. Uses skipAvailabilityValidation + skipBusinessConfirmation
 * so staff-created NailIQ bookings don't get blocked by Wix's own schedule checks.
 * Returns the new Wix booking ID, or throws on failure.
 */
export async function createWixBooking(
  siteId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const r = (await post(WRITER, siteId, body)) as { booking?: { id?: string } };
  const id = r.booking?.id;
  if (!id) throw new Error(`createWixBooking: no booking.id in response — ${JSON.stringify(r).slice(0, 200)}`);
  return id;
}

/**
 * Check if a Wix staff resource has an active booking overlapping [startDateIso, endDateIso).
 * Returns true if a conflict is found (slot taken), false if free.
 * Fail-open: on any error returns false so a Wix outage never blocks the NailIQ booking flow.
 */
export async function checkWixSlotConflict(
  siteId: string,
  resourceId: string,
  startDateIso: string, // ISO UTC e.g. "2026-06-05T14:00:00.000Z"
  endDateIso: string,
): Promise<boolean> {
  try {
    const r = (await post(READER, siteId, {
      query: {
        filter: {
          $and: [
            { "booking.bookedEntity.slot.resource.id": { $eq: resourceId } },
            { "booking.startDate": { $lt: endDateIso } },
            { "booking.endDate": { $gt: startDateIso } },
            { "booking.status": { $nin: ["CANCELED", "CANCELLED", "DECLINED"] } },
          ],
        },
        paging: { limit: 1 },
      },
    })) as { extendedBookings?: unknown[] };
    return (r.extendedBookings?.length ?? 0) > 0;
  } catch {
    // Fail open — Wix API down or key missing → don't block the booking flow.
    return false;
  }
}
