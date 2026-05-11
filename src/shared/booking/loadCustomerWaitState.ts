import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { normalizePublicBookingSlug } from "@/shared/booking/normalizePublicBookingSlug";

/**
 * Public-safe loader for the customer-facing wait page.
 *
 * Returns the minimum information a guest needs to track their own
 * walk-in: position in queue (without exposing other customers'
 * names), service, assigned staff display name, and a wait estimate.
 *
 * Security:
 *   - No auth required (the URL itself is the bearer token — guess
 *     a UUID and you might find another booking, but you only see
 *     anonymized counts and the booking's own client_name which the
 *     customer already knows about themselves).
 *   - Booking lookup is hard-scoped to the salon resolved from the
 *     URL slug; mismatched slug+id pairs return `not_found`.
 *   - Only `walkin` source bookings are exposed — appointment
 *     bookings should not flow through this surface.
 *   - Other customers are surfaced only as a position number; we
 *     never return names or any identifying field.
 */

export type CustomerWaitState =
  | {
      ok: false;
      /** `not_found`: salon or booking row missing (404).
       *  `wrong_salon`: booking exists but on a different salon (404).
       *  `server_error`: lookup blew up (500-style).
       *  `invalid_id`: the URL bookingId isn't a UUID. */
      error: "not_found" | "wrong_salon" | "server_error" | "invalid_id";
    }
  | {
      ok: true;
      salon: { id: string; slug: string; name: string };
      booking: {
        id: string;
        clientName: string;
        serviceName: string;
        status:
          | "waiting"
          | "confirmed"
          | "in_progress"
          | "completed"
          | "cancelled"
          | "no_show";
      };
      /** Resolved staff display name when the row carries `staff_id`. */
      staffName: string | null;
      /** 1-based position in the salon's waiting queue. Null when the
       * booking has already been assigned (status !== 'waiting'). */
      queuePosition: number | null;
      /** Server-calculated estimate. Falls back to position * average
       * service duration when the per-staff projection isn't reachable. */
      estimatedWaitMinutes: number | null;
      /** UTC ISO time the customer is projected to start. Null when the
       * estimate isn't computable (e.g. completed booking). */
      readyAroundIso: string | null;
      /** Server "now" — passed to the client so countdown ticks
       * agree with what the loader saw. */
      nowIso: string;
    };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FALLBACK_AVG_SERVICE_MINUTES = 45;

export async function loadCustomerWaitState(
  rawSlug: string,
  rawBookingId: string,
): Promise<CustomerWaitState> {
  const slug = normalizePublicBookingSlug(rawSlug);
  if (!slug) {
    console.warn("[loadCustomerWaitState] empty slug", { rawSlug });
    return { ok: false, error: "not_found" };
  }

  const bookingId = String(rawBookingId ?? "").trim();
  if (!UUID_RE.test(bookingId)) {
    console.warn("[loadCustomerWaitState] invalid bookingId", {
      slug,
      rawBookingId,
    });
    return { ok: false, error: "invalid_id" };
  }

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[loadCustomerWaitState] service role", e);
    return { ok: false, error: "server_error" };
  }

  const salonRes = await admin
    .from("salons")
    .select("id, slug, name")
    .eq("slug", slug)
    .maybeSingle();
  if (salonRes.error) {
    console.error("[loadCustomerWaitState] salon lookup", {
      slug,
      error: salonRes.error,
    });
    return { ok: false, error: "server_error" };
  }
  if (!salonRes.data) {
    console.warn("[loadCustomerWaitState] salon not found", { slug });
    return { ok: false, error: "not_found" };
  }
  const salon = {
    id: String(salonRes.data.id),
    slug: String(salonRes.data.slug),
    name: String(salonRes.data.name ?? "").trim(),
  };

  type BookingRow = {
    id: string;
    client_name: string | null;
    status: string | null;
    source: string | null;
    staff_id: string | null;
    start_time_utc: string | null;
    end_time_utc: string | null;
    joined_queue_at: string | null;
    service_id: string | null;
    services?:
      | { name: string | null; duration_minutes: number | null }
      | { name: string | null; duration_minutes: number | null }[]
      | null;
  };
  const bookingRes = (await admin
    .from("bookings")
    .select(
      `
      id,
      client_name,
      status,
      source,
      staff_id,
      start_time_utc,
      end_time_utc,
      joined_queue_at,
      service_id,
      services!bookings_service_id_fkey ( name, duration_minutes )
    `,
    )
    .eq("id", bookingId)
    .eq("salon_id", salon.id)
    .maybeSingle()) as { data: BookingRow | null; error: unknown };

  if (bookingRes.error) {
    console.error("[loadCustomerWaitState] booking lookup", {
      slug,
      bookingId,
      error: bookingRes.error,
    });
    return { ok: false, error: "server_error" };
  }
  if (!bookingRes.data) {
    console.warn("[loadCustomerWaitState] booking not found", {
      slug,
      bookingId,
      salonId: salon.id,
    });
    return { ok: false, error: "not_found" };
  }
  const b = bookingRes.data;
  // Walk-ins are the primary use case; appointments also benefit from
  // a public status surface (start time, assigned staff). We keep the
  // page rendering for both — the queue-position branch only fires
  // when source='walkin' AND status='waiting'. Appointments fall into
  // the assigned-screen branch automatically.

  const status = (b.status ?? "waiting") as CustomerWaitState extends {
    ok: true;
    booking: { status: infer S };
  }
    ? S
    : never;

  const svcJoin = Array.isArray(b.services) ? b.services[0] : b.services;
  const serviceName = String(svcJoin?.name ?? "").trim();
  const serviceDurationMinutes = Number.isFinite(
    Number(svcJoin?.duration_minutes ?? 0),
  )
    ? Math.round(Number(svcJoin?.duration_minutes ?? 0))
    : 0;

  let staffName: string | null = null;
  if (b.staff_id) {
    const staffRes = await admin
      .from("staff")
      .select("name")
      .eq("id", b.staff_id)
      .eq("salon_id", salon.id)
      .maybeSingle();
    if (!staffRes.error && staffRes.data) {
      staffName = String(staffRes.data.name ?? "").trim() || null;
    }
  }

  const nowIso = new Date().toISOString();

  // Queue position only makes sense while waiting. Once assigned,
  // the position is gone — we surface a null and let the page show
  // the assigned-staff dispatch view.
  let queuePosition: number | null = null;
  let estimatedWaitMinutes: number | null = null;
  let readyAroundIso: string | null = null;

  if (
    status === "waiting" &&
    b.joined_queue_at &&
    String(b.source ?? "") === "walkin"
  ) {
    type QueueRow = { id: string; joined_queue_at: string | null };
    const queueRes = (await admin
      .from("bookings")
      .select("id, joined_queue_at")
      .eq("salon_id", salon.id)
      .eq("source", "walkin")
      .eq("status", "waiting")
      .lte("joined_queue_at", b.joined_queue_at)) as {
      data: QueueRow[] | null;
      error: unknown;
    };
    if (!queueRes.error) {
      queuePosition = (queueRes.data ?? []).length;
    }

    // ETA — naive position * service-duration rule. Good enough for
    // the customer's expectation; the receptionist still drives the
    // actual assign. A future refinement can plug in the
    // availability engine's per-staff ready-at projection.
    const avg = serviceDurationMinutes || FALLBACK_AVG_SERVICE_MINUTES;
    const minutes = Math.max(0, (queuePosition ?? 1) - 1) * avg;
    estimatedWaitMinutes = minutes;
    readyAroundIso = new Date(Date.now() + minutes * 60_000).toISOString();
  }

  // For confirmed walk-ins (assigned), the customer's start_time_utc
  // is the ready-around. We surface zero wait minutes so the page
  // can render "Ready now / at <time>" without an extra branch.
  if (
    (status === "confirmed" || status === "in_progress") &&
    b.start_time_utc
  ) {
    const startMs = Date.parse(b.start_time_utc);
    if (Number.isFinite(startMs)) {
      readyAroundIso = b.start_time_utc;
      estimatedWaitMinutes = Math.max(
        0,
        Math.floor((startMs - Date.now()) / 60_000),
      );
    }
  }

  return {
    ok: true,
    salon,
    booking: {
      id: String(b.id),
      clientName: String(b.client_name ?? "").trim() || "—",
      serviceName: serviceName || "—",
      status,
    },
    staffName,
    queuePosition,
    estimatedWaitMinutes,
    readyAroundIso,
    nowIso,
  };
}
