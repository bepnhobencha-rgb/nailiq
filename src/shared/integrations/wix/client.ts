/**
 * Wix Bookings REST client (server-only).
 *
 * Auth: account API key in `WIX_API_KEY` + per-call `wix-site-id` header.
 * The key needs Wix Bookings **Manage** (write) scope for confirm/cancel and
 * **Read** for the query. Generated at manage.wix.com/account/api-keys.
 */
import "server-only";

const READER = "https://www.wixapis.com/bookings/bookings-reader/v2/extended-bookings/query";
const WRITER = "https://www.wixapis.com/bookings/v2/bookings";

export type WixBooking = {
  id: string;
  status: string; // CONFIRMED | PENDING | CREATED | CANCELED | DECLINED | WAITING_LIST
  revision: string;
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

function headers(siteId: string): HeadersInit {
  // Strip any whitespace/newlines — pasting the key into a dashboard env field often line-wraps
  // it, which would make `Authorization` an invalid HTTP header value. Wix keys contain none.
  const key = (process.env.WIX_API_KEY ?? "").replace(/\s+/g, "");
  if (!key) throw new Error("WIX_API_KEY is not set");
  return { "Content-Type": "application/json", Authorization: key, "wix-site-id": siteId };
}

async function post(url: string, siteId: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: headers(siteId), body: JSON.stringify(body) });
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

/** Confirm a PENDING/CREATED Wix booking → CONFIRMED. Fetches the current revision first. */
export async function confirmWixBooking(siteId: string, bookingId: string): Promise<string> {
  const b = await getBooking(siteId, bookingId);
  if (!b) throw new Error("booking_not_found");
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
  const r = (await post(`${WRITER}/${bookingId}/cancel`, siteId, {
    participantNotification: { notifyParticipants: false },
    bookingId,
    revision: b.revision,
  })) as { booking?: WixBooking };
  return r.booking?.status ?? "UNKNOWN";
}

/** Decline a PENDING/CREATED Wix booking → DECLINED (the "reject request" action). */
export async function declineWixBooking(siteId: string, bookingId: string): Promise<string> {
  const b = await getBooking(siteId, bookingId);
  if (!b) throw new Error("booking_not_found");
  const r = (await post(`${WRITER}/${bookingId}/decline`, siteId, {
    participantNotification: { notifyParticipants: false },
    bookingId,
    revision: b.revision,
  })) as { booking?: WixBooking };
  return r.booking?.status ?? "UNKNOWN";
}
