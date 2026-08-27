/**
 * Square -> NailIQ forward sync (stateless; called by the Vercel cron).
 *
 * Each run pulls the location's bookings in a rolling window (yesterday ..
 * +90 days) and reconciles them into NailIQ:
 *   - new active booking      -> insert only when the configured Square
 *                                location, service and exact capacity mapping
 *                                match. It maps to exactly one provider-backed
 *                                staff or resource identity; resource-enabled
 *                                staff appointments auto-assign a separate free
 *                                resource and never conflate the two dimensions.
 *   - status/time change      -> update the existing row (cancellations,
 *                                reschedules, no-shows reflected on the calendar).
 *   - unknown customer        -> fetched on demand and atomically linked inside
 *                                its Square environment + merchant namespace to
 *                                a canonical-phone client profile and salon.
 *
 * Idempotent on bookings.square_booking_id and the scoped Square customer
 * identity resolver. The legacy client_profiles.square_customer_id column is
 * never used for new bindings because provider ids are not globally unique.
 * ListBookings has no "updated since" filter, so we re-scan the forward window
 * each run and upsert; the watermark is advanced for observability only.
 */
import { after } from "next/server";
import "server-only";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import { resolveSquareCustomerIdentity } from "./customerIdentity";
import { looseServiceClient } from "./looseDb";
import {
  getSquareConfig,
  listBookings,
  listCatalogItems,
  getCustomer,
  cancelSquareBooking,
  createSquareBooking,
  updateSquareBookingTime,
  ensureSquareCustomer,
  type SquareBooking,
} from "./client";
import {
  assertExactSquareBookingWritebackReceipt,
  assertSquareBookingWritebackInventoryContext,
  beginSquareBookingWritebackDispatch,
  claimSquareBookingWriteback,
  claimSquareBookingWritebackReconciliation,
  completeSquareBookingWritebackSuccess,
  findSquareBookingWritebackCorrelation,
  markSquareBookingWritebackUnknown,
  recordSquareBookingWritebackCustomer,
} from "./bookingWriteback";

const RENDER_STATUS = new Set(["pending", "confirmed", "in_progress", "completed"]);
const ACTIVE_SQUARE = new Set(["ACCEPTED", "PENDING"]);
const REVERSE_CREATE_NOTE_PREFIX = "NailIQ booking:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_MAP: Record<string, string> = {
  ACCEPTED: "confirmed",
  PENDING: "pending",
  CANCELLED_BY_CUSTOMER: "cancelled",
  CANCELLED_BY_SELLER: "cancelled",
  DECLINED: "cancelled",
  NO_SHOW: "no_show",
};
const norm = (s: string) => s.toLowerCase().replace(/^\s*\d+\s*[-.]\s*/, "").replace(/[^a-z0-9]/g, "");
const safeName = (s: string) => s.replace(/&/g, "and").replace(/[<>{}=;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;
const str = (v: unknown): string => (v == null ? "" : String(v));

type BookingInsertError = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
};

function expectedInboundBookingInsertConflict(error: BookingInsertError): boolean {
  const code = str(error.code).trim();
  if (code === "23P01") return true;
  if (code !== "23505") return false;
  const material = [error.message, error.details, error.hint]
    .map(str)
    .join(" ")
    .toLowerCase();
  return material.includes("bookings_square_booking_id_key")
    || material.includes("square_booking_id");
}

function databaseErrorCode(error: BookingInsertError): string {
  return str(error.code).trim() || "unknown";
}

function addExactProviderMapping(
  mapping: Map<string, string>,
  ambiguousProviderIds: Set<string>,
  providerIdValue: unknown,
  localIdValue: unknown,
): void {
  const providerId = str(providerIdValue).trim();
  const localId = str(localIdValue).trim();
  if (!providerId || !localId || ambiguousProviderIds.has(providerId)) return;
  const existing = mapping.get(providerId);
  if (existing && existing !== localId) {
    mapping.delete(providerId);
    ambiguousProviderIds.add(providerId);
    return;
  }
  mapping.set(providerId, localId);
}

type SquareCreateSnapshot = {
  id: string;
  salonId: string;
  serviceId: string;
  staffId: string;
  status: "confirmed" | "pending";
  startTimeUtc: string;
  endTimeUtc: string;
};

function correlatedNailIqBookingId(booking: SquareBooking): string | null {
  const note = booking.seller_note;
  if (typeof note !== "string" || !note.startsWith(REVERSE_CREATE_NOTE_PREFIX)) {
    return null;
  }
  const bookingId = note.slice(REVERSE_CREATE_NOTE_PREFIX.length);
  return UUID_RE.test(bookingId) ? bookingId.toLowerCase() : null;
}

function snapshotFromRow(
  row: Record<string, unknown>,
  salonId: string,
): SquareCreateSnapshot | null {
  const id = str(row.id);
  const serviceId = str(row.service_id);
  const staffId = str(row.staff_id);
  const status = row.status;
  const startTimeUtc = str(row.start_time_utc);
  const endTimeUtc = str(row.end_time_utc);
  if (
    !UUID_RE.test(id)
    || row.salon_id !== salonId
    || !serviceId
    || !staffId
    || (status !== "confirmed" && status !== "pending")
    || row.deleted_at != null
    || !Number.isFinite(Date.parse(startTimeUtc))
    || !Number.isFinite(Date.parse(endTimeUtc))
    || Date.parse(endTimeUtc) <= Date.parse(startTimeUtc)
  ) return null;
  return {
    id: id.toLowerCase(),
    salonId,
    serviceId,
    staffId,
    status,
    startTimeUtc,
    endTimeUtc,
  };
}

export interface SquareSyncResult {
  pulled: number;
  inserted: number;
  updated: number;
  customersAdded: number;
  skipped: number;
  /** Tầng 1 reverse sync — NailIQ-side cancellations pushed to Square. */
  cancelledInSquare: number;
  /** Tầng 2 reverse sync — NailIQ-created bookings mirrored into Square (opt-in). */
  createdInSquare: number;
  /** Tầng 3 reverse sync — NailIQ reschedules pushed to Square (opt-in). */
  updatedInSquare: number;
}

/** Find an active bed/staff with no rendered booking overlapping [startMs,endMs)
 *  — used to re-home a Square-rescheduled booking whose new time collides with
 *  its current bed (bookings_no_overlap GIST). Returns null when every bed is
 *  busy at the new slot. */
async function findFreeStaffForInterval(
  db: ReturnType<typeof looseServiceClient>,
  salonId: string,
  activeStaff: string[],
  startMs: number,
  endMs: number,
  excludeBookingId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("bookings")
    .select("staff_id, status")
    .eq("salon_id", salonId)
    .not("id", "eq", excludeBookingId)
    .not("staff_id", "is", null)
    .lt("start_time_utc", new Date(endMs).toISOString())
    .gt("end_time_utc", new Date(startMs).toISOString());
  if (error) throw new Error("square_sync_staff_capacity_lookup_unavailable");
  const busy = new Set<string>();
  for (const r of data ?? []) if (RENDER_STATUS.has(str(r.status))) busy.add(str(r.staff_id));
  for (const sid of activeStaff) if (!busy.has(sid)) return sid;
  return null;
}

async function recoverCorrelatedSquareBooking(
  db: ReturnType<typeof looseServiceClient>,
  cfg: Awaited<ReturnType<typeof getSquareConfig>>,
  booking: SquareBooking,
  bookingId: string,
  requireSellerNote: boolean,
): Promise<"already_bound" | "recovered"> {
  const { data, error } = await db
    .from("bookings")
    .select("id, salon_id, square_booking_id")
    .eq("id", bookingId)
    .eq("salon_id", cfg.salonId)
    .maybeSingle();
  if (error || !data) throw new Error("square_create_correlation_missing");

  const existingSquareId = data.square_booking_id;
  if (existingSquareId != null) {
    if (existingSquareId !== booking.id) {
      throw new Error("square_create_correlation_binding_conflict");
    }
    // A tagged booking is special only while the local row is unbound. Once
    // bound to this exact provider ID it must rejoin the ordinary lifecycle so
    // later cancels, reschedules, completions and Square-side edits reconcile.
    return "already_bound";
  }

  // Only a pre-existing durable unknown receipt may authorize recovery. A
  // seller_note alone is user-editable provider data and is never sufficient
  // to attach an unbound local row.
  const claim = await claimSquareBookingWritebackReconciliation(
    db,
    cfg,
    bookingId,
  );
  assertExactSquareBookingWritebackReceipt(booking, claim, { requireSellerNote });
  await completeSquareBookingWritebackSuccess(db, claim, {
    providerBookingId: booking.id,
    providerCustomerId: claim.providerCustomerId,
    providerBookingVersion: Number(booking.version),
  });
  return "recovered";
}

export async function runSquareForwardSync(salonId: string): Promise<SquareSyncResult> {
  const db = looseServiceClient();
  const cfg = await getSquareConfig(db, salonId);
  const { data: salonMode, error: salonModeError } = await db
    .from("salons")
    .select("resources_enabled")
    .eq("id", salonId)
    .maybeSingle();
  if (salonModeError) throw new Error("square_sync_salon_resource_mode_unavailable");
  const resourcesEnabled = salonMode?.resources_enabled === true;

  const now = new Date();
  const begin = new Date(now.getTime() - 86_400_000);
  const end = new Date(now.getTime() + 90 * 86_400_000);
  const bookings = (await listBookings(cfg, begin, end)) as SquareBooking[];

  // service variation -> NailIQ service
  const items = await listCatalogItems(cfg);
  const variationToItemName = new Map<string, string>();
  for (const it of items) for (const v of it.variations) variationToItemName.set(v.id, it.name);
  const variationByNorm = new Map<string, { variationId: string; version: number }>();
  for (const it of items) {
    const itemNorm = norm(it.name);
    if (variationByNorm.has(itemNorm)) continue;
    const variation = it.variations.find((candidate) => typeof candidate.version === "number");
    if (variation && typeof variation.version === "number") {
      variationByNorm.set(itemNorm, {
        variationId: variation.id,
        version: variation.version,
      });
    }
  }
  const { data: svcRows, error: svcRowsError } = await db
    .from("services")
    .select("id, name, price_cents")
    .eq("salon_id", salonId)
    .is("deleted_at", null);
  if (svcRowsError) throw new Error("square_sync_service_inventory_unavailable");
  const svcByNorm = new Map<string, { id: string; price_cents: number }>();
  const ambiguousServiceNames = new Set<string>();
  for (const service of svcRows ?? []) {
    const normalizedName = norm(str(service.name));
    const serviceId = str(service.id);
    if (!normalizedName || !serviceId || ambiguousServiceNames.has(normalizedName)) continue;
    const existing = svcByNorm.get(normalizedName);
    if (existing && existing.id !== serviceId) {
      svcByNorm.delete(normalizedName);
      ambiguousServiceNames.add(normalizedName);
      continue;
    }
    svcByNorm.set(normalizedName, {
      id: serviceId,
      price_cents: Number(service.price_cents),
    });
  }
  const serviceIdToNorm = new Map<string, string>();
  for (const service of svcRows ?? []) {
    serviceIdToNorm.set(str(service.id), norm(str(service.name)));
  }

  // Staff and resources are independent scheduling dimensions. Square's
  // appointment_segment.team_member_id maps to exactly one of them depending
  // on the salon's approved resource mode; it must never be copied into both.
  const { data: staffRows, error: staffRowsError } = await db
    .from("staff")
    .select("id, square_team_member_id")
    .eq("salon_id", salonId)
    .eq("status", "active")
    .is("deleted_at", null);
  if (staffRowsError) throw new Error("square_sync_staff_inventory_unavailable");
  const activeStaff: string[] = (staffRows ?? []).map((s) => str(s.id));
  const tmToStaff = new Map<string, string>();
  const ambiguousStaffTeamMembers = new Set<string>();
  for (const staff of staffRows ?? []) {
    addExactProviderMapping(
      tmToStaff,
      ambiguousStaffTeamMembers,
      staff.square_team_member_id,
      staff.id,
    );
  }
  const staffToTeamMember = new Map<string, string>();
  for (const staff of staffRows ?? []) {
    if (staff.square_team_member_id) {
      staffToTeamMember.set(str(staff.id), str(staff.square_team_member_id));
    }
  }

  const staffOccupancy = new Map<string, [number, number][]>();
  for (const id of activeStaff) staffOccupancy.set(id, []);
  const { data: staffOccupancyRows, error: staffOccupancyError } = await db
    .from("bookings").select("staff_id, start_time_utc, end_time_utc, status")
    .eq("salon_id", salonId).not("staff_id", "is", null).gte("start_time_utc", begin.toISOString()).lt("start_time_utc", end.toISOString());
  if (staffOccupancyError) throw new Error("square_sync_staff_occupancy_unavailable");
  for (const r of staffOccupancyRows ?? []) {
    const intervals = staffOccupancy.get(str(r.staff_id));
    if (RENDER_STATUS.has(str(r.status)) && intervals) {
      intervals.push([Date.parse(str(r.start_time_utc)), Date.parse(str(r.end_time_utc))]);
    }
  }

  const teamMemberToResource = new Map<string, string>();
  const ambiguousResourceTeamMembers = new Set<string>();
  const resourceOccupancy = new Map<string, [number, number][]>();
  const activeResourceIds: string[] = [];
  if (resourcesEnabled) {
    const { data: resourceRows, error: resourceRowsError } = await db
      .from("salon_resources")
      .select("id, square_team_member_id, display_order")
      .eq("salon_id", salonId)
      .eq("status", "active")
      .is("deleted_at", null);
    if (resourceRowsError) throw new Error("square_sync_resource_inventory_unavailable");
    const orderedResources = [...(resourceRows ?? [])].sort((left, right) => {
      const displayOrder = Number(left.display_order) - Number(right.display_order);
      return displayOrder || str(left.id).localeCompare(str(right.id));
    });
    for (const resource of orderedResources) {
      const resourceId = str(resource.id);
      activeResourceIds.push(resourceId);
      resourceOccupancy.set(resourceId, []);
      addExactProviderMapping(
        teamMemberToResource,
        ambiguousResourceTeamMembers,
        resource.square_team_member_id,
        resourceId,
      );
    }

    const { data: resourceOccupancyRows, error: resourceOccupancyError } = await db
      .from("bookings")
      .select("resource_id, start_time_utc, end_time_utc, status")
      .eq("salon_id", salonId)
      .not("resource_id", "is", null)
      .gte("start_time_utc", begin.toISOString())
      .lt("start_time_utc", end.toISOString());
    if (resourceOccupancyError) throw new Error("square_sync_resource_occupancy_unavailable");
    for (const row of resourceOccupancyRows ?? []) {
      const intervals = resourceOccupancy.get(str(row.resource_id));
      if (RENDER_STATUS.has(str(row.status)) && intervals) {
        intervals.push([Date.parse(str(row.start_time_utc)), Date.parse(str(row.end_time_utc))]);
      }
    }
  }

  let inserted = 0, updated = 0, customersAdded = 0, skipped = 0;
  // Owner-notify guard: cap emails per sync run so a bulk import can't storm.
  const OWNER_NOTIFY_CAP = 5;
  let ownerNotifyCount = 0;
  const clientCache = new Map<string, {
    clientProfileId: string | null;
    name: string | null;
    phone: string | null;
  }>();
  const resolveSquareClient = async (customerId: string | undefined) => {
    if (!customerId) return undefined;
    const requestedCustomerId = customerId.trim();
    if (!requestedCustomerId || requestedCustomerId !== customerId) {
      throw new Error("square_sync_customer_id_invalid");
    }
    const cacheKey = `${cfg.environment}\n${cfg.merchantId}\n${requestedCustomerId}`;
    let client = clientCache.get(cacheKey);
    if (client) return client;

    const existingIdentity = await resolveSquareCustomerIdentity(db, cfg, {
      customerId: requestedCustomerId,
    });
    if (existingIdentity) {
      client = {
        clientProfileId: existingIdentity.clientProfileId,
        name: existingIdentity.name,
        phone: existingIdentity.phone,
      };
    } else {
      const squareCustomer = await getCustomer(cfg, requestedCustomerId);
      if (squareCustomer && squareCustomer.id !== requestedCustomerId) {
        throw new Error("square_sync_customer_response_mismatch");
      }
      const phone = toCanonicalPhone(squareCustomer?.phone_number);
      const name = safeName([
        squareCustomer?.given_name ?? "",
        squareCustomer?.family_name ?? "",
      ].join(" "));
      if (squareCustomer && phone) {
        const identity = await resolveSquareCustomerIdentity(db, cfg, {
          customerId: requestedCustomerId,
          phone,
          name: name || null,
          email: (squareCustomer.email_address ?? "").trim().toLowerCase() || null,
        });
        if (!identity) throw new Error("square_sync_customer_identity_response_invalid");
        if (identity.createdProfile) customersAdded++;
        client = {
          clientProfileId: identity.clientProfileId,
          name: identity.name ?? (name || null),
          phone: identity.phone ?? phone,
        };
      } else {
        client = { clientProfileId: null, name: name || null, phone };
      }
    }
    clientCache.set(cacheKey, client);
    return client;
  };

  const { data: pendingWritebacks, error: pendingWritebacksError } = await db
    .from("square_booking_writeback_operations")
    .select("booking_id, status, material, material_fingerprint, provider_account_fingerprint, provider_customer_id, provider_booking_id")
    .eq("salon_id", salonId)
    .in("status", ["sending", "unknown", "reconciling"]);
  if (pendingWritebacksError) {
    throw new Error("square_booking_writeback_reconciliation_inventory_unavailable");
  }
  assertSquareBookingWritebackInventoryContext(pendingWritebacks ?? [], cfg);

  for (const b of bookings) {
    // The provider list is requested with location_id, but tenant isolation must
    // not rely on a remote filter being honored. Reject before any per-booking
    // customer lookup, reconciliation claim or database mutation.
    if (b.location_id !== cfg.locationId) { skipped++; continue; }

    const notedBookingId = correlatedNailIqBookingId(b);
    const durableBookingId = findSquareBookingWritebackCorrelation(
      pendingWritebacks ?? [],
      b,
      cfg,
    );
    if (notedBookingId && durableBookingId && notedBookingId !== durableBookingId) {
      throw new Error("square_booking_writeback_correlation_conflict");
    }
    const correlatedBookingId = notedBookingId ?? durableBookingId;
    if (correlatedBookingId) {
      const correlation = await recoverCorrelatedSquareBooking(
        db,
        cfg,
        b,
        correlatedBookingId,
        durableBookingId === null,
      );
      if (correlation === "recovered") continue;
    }

    const segments = b.appointment_segments ?? [];
    const seg = segments[0];
    const itemName = seg?.service_variation_id ? variationToItemName.get(seg.service_variation_id) : undefined;
    const svc = itemName ? svcByNorm.get(norm(itemName)) : undefined;
    if (!svc || !b.start_at) { skipped++; continue; }

    const targetStatus = STATUS_MAP[b.status];
    if (!targetStatus) { skipped++; continue; }

    const segmentDurations = segments.map((segment) => Number(segment.duration_minutes));
    if (
      segmentDurations.length === 0
      || segmentDurations.some((duration) => (
        !Number.isInteger(duration) || duration <= 0 || duration > 1_500
      ))
    ) {
      skipped++;
      continue;
    }
    const durMin = segmentDurations.reduce((sum, duration) => sum + duration, 0);
    const startMs = Date.parse(b.start_at);
    const endMs = startMs + durMin * 60_000;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      skipped++;
      continue;
    }

    const { data: existing, error: existingError } = await db
      .from("bookings")
      .select("id, status, start_time_utc, end_time_utc, staff_id, client_profile_id, local_updated_at, rescheduled_at")
      .eq("square_booking_id", b.id)
      .eq("salon_id", salonId)
      .maybeSingle();
    if (existingError) throw new Error("square_sync_existing_booking_lookup_unavailable");

    if (existing) {
      // Preserve the established customer-link refresh for already-imported
      // appointments. New rejected imports do not reach this resolver.
      const client = await resolveSquareClient(b.customer_id);
      const existingId = str(existing.id);
      const existingClientProfileId = str(existing.client_profile_id).toLowerCase();
      if (
        client?.clientProfileId
        && existingClientProfileId
        && existingClientProfileId !== client.clientProfileId
      ) {
        throw new Error("square_sync_customer_binding_conflict");
      }
      if (client?.clientProfileId && !existingClientProfileId) {
        const { data: boundBooking, error: bindingError } = await db
          .from("bookings")
          .update({ client_profile_id: client.clientProfileId })
          .eq("id", existingId)
          .eq("salon_id", salonId)
          .is("client_profile_id", null)
          .select("client_profile_id")
          .maybeSingle();
        if (bindingError) {
          throw new Error("square_sync_customer_binding_unavailable");
        }
        let observedProfileId = str(boundBooking?.client_profile_id).toLowerCase();
        if (!observedProfileId) {
          // A zero-row guarded UPDATE is not success: another writer may have
          // filled the FK after our initial read. Re-read the exact tenant row
          // and accept only an idempotent same-profile winner.
          const { data: concurrentBooking, error: concurrentBindingError } = await db
            .from("bookings")
            .select("client_profile_id")
            .eq("id", existingId)
            .eq("salon_id", salonId)
            .maybeSingle();
          if (concurrentBindingError) {
            throw new Error("square_sync_customer_binding_unavailable");
          }
          observedProfileId = str(concurrentBooking?.client_profile_id).toLowerCase();
        }
        if (observedProfileId !== client.clientProfileId) {
          throw new Error("square_sync_customer_binding_conflict");
        }
      }

      // The desk owns the workflow status once a booking has been started,
      // completed, or no-showed in NailIQ — Square (which only knows ACCEPTED)
      // must NOT clobber it back to "confirmed" on the next sync. (Bug: a
      // receptionist-completed Square booking reverted to "not started".)
      // Square's own state still applies while the booking is pending/confirmed.
      const localStatus = str(existing.status);
      const deskOwned =
        localStatus === "in_progress" ||
        localStatus === "completed" ||
        localStatus === "no_show";

      const updates: Record<string, unknown> = {};
      if (!deskOwned && localStatus !== targetStatus) {
        // A Square→NailIQ status change is a CANCEL (→ pull_cancel toggle) or any
        // other status move (→ pull_update toggle); admin can switch each off.
        const isCancel = targetStatus === "cancelled";
        // NEVER let a still-ACCEPTED Square booking REVIVE one cancelled in
        // NailIQ. The cancel hasn't been pushed to Square yet — the reverse pass
        // (Tầng 1) does that. Without this guard the forward pull flips it back
        // to "confirmed" every run, AND the reverse-cancel then can't find it
        // (no longer 'cancelled') → the cancel is lost and the booking
        // "reappears 5 min after the desk cancels it". Square-origin cancels are
        // unaffected (targetStatus would be 'cancelled' → isCancel path).
        const wouldReviveLocalCancel =
          localStatus === "cancelled" && targetStatus !== "cancelled";
        if (
          !wouldReviveLocalCancel &&
          (isCancel ? cfg.sync.pullCancel : cfg.sync.pullUpdate)
        ) {
          updates.status = targetStatus;
        }
      }

      // RESCHEDULE sync (Square → NailIQ): Square's ListBookings has no
      // "updated since" filter, so a time change on an EXISTING booking was
      // never reflected — the row kept its original time and the desk saw the
      // wrong slot. Update start/end when Square's time moved, but only for a
      // booking the desk hasn't taken over and that's still active (a cancelled
      // booking's time is moot).
      const newStart = new Date(startMs).toISOString();
      const newEnd = new Date(endMs).toISOString();
      // Compare by instant (ms), not string — the DB returns timestamptz as
      // "2026-06-15 19:30:00+00" while newStart is ISO "…T19:30:00.000Z"; a
      // string compare would read every booking as moved and rewrite it each run.
      const timeMoved =
        Date.parse(str(existing.start_time_utc)) !== startMs ||
        Date.parse(str(existing.end_time_utc)) !== endMs;
      // Last-writer-wins: only PULL Square's time when Square's edit is at least
      // as recent as NailIQ's last local edit. Otherwise NailIQ owns the slot
      // (a desk drag / customer / voice reschedule) and the reverse push (Tầng 3)
      // will carry it TO Square — pulling here would fight that and revert it.
      const localEditMs = Math.max(
        existing.local_updated_at ? Date.parse(str(existing.local_updated_at)) : 0,
        existing.rescheduled_at ? Date.parse(str(existing.rescheduled_at)) : 0,
      );
      const squareIsNewer = (b.updated_at ? Date.parse(b.updated_at) : 0) >= localEditMs;
      if (!deskOwned && RENDER_STATUS.has(targetStatus) && timeMoved && cfg.sync.pullUpdate && squareIsNewer) {
        updates.start_time_utc = newStart;
        updates.end_time_utc = newEnd;
      }

      if (Object.keys(updates).length > 0) {
        const { error } = await db.from("bookings").update(updates).eq("id", existingId);
        if (error) {
          const updateErrorCode = databaseErrorCode(error);
          if (updateErrorCode !== "23P01") {
            throw new Error(`square_sync_booking_update_failed:${updateErrorCode}`);
          }
          // A staff-mode time move can collide with another booking on the same
          // staff column (bookings_no_overlap GIST → 23P01). Re-home only that
          // legacy mode. Resource-mode never invents a staff assignment; its
          // collision remains skipped for explicit reconciliation.
          if (updates.start_time_utc && !resourcesEnabled) {
            const freeStaff = await findFreeStaffForInterval(
              db, salonId, activeStaff, startMs, endMs, existingId,
            );
            if (freeStaff) {
              const { error: e2 } = await db
                .from("bookings")
                .update({ ...updates, staff_id: freeStaff })
                .eq("id", existingId);
              if (!e2) updated++;
              else if (databaseErrorCode(e2) === "23P01") skipped++;
              else {
                throw new Error(
                  `square_sync_booking_rehome_failed:${databaseErrorCode(e2)}`,
                );
              }
            } else {
              skipped++;
            }
          } else {
            skipped++;
          }
        } else {
          updated++;
        }
      }
      continue;
    }

    // new booking: only materialise active ones (skip brand-new already-cancelled)
    if (!RENDER_STATUS.has(targetStatus)) { skipped++; continue; }
    if (!cfg.sync.pullCreate) { skipped++; continue; } // pull-create toggle off
    // NailIQ's legacy pull path materialises one canonical service per booking.
    // Do not silently collapse a Square multi-segment appointment into the
    // first service with a combined duration; that would misstate the calendar
    // and price. Existing linked multi-segment rows can still reconcile their
    // lifecycle/time, but a new import waits for an atomic segment-aware path.
    if (segments.length !== 1) { skipped++; continue; }

    const teamMemberId = str(seg?.team_member_id).trim();
    let staffId: string | null = null;
    let resourceId: string | null = null;
    const selectedOccupancies: [number, number][][] = [];
    if (resourcesEnabled) {
      const staffMapping = tmToStaff.get(teamMemberId);
      const resourceMapping = teamMemberToResource.get(teamMemberId);
      if (
        ambiguousStaffTeamMembers.has(teamMemberId)
        || ambiguousResourceTeamMembers.has(teamMemberId)
        || (staffMapping && resourceMapping)
        || (!staffMapping && !resourceMapping)
      ) {
        skipped++;
        continue;
      }

      if (resourceMapping) {
        resourceId = resourceMapping;
        const intervals = resourceOccupancy.get(resourceId);
        if (!intervals) { skipped++; continue; }
        selectedOccupancies.push(intervals);
      } else {
        staffId = staffMapping ?? null;
        const staffIntervals = staffId ? staffOccupancy.get(staffId) : undefined;
        if (!staffIntervals) { skipped++; continue; }
        selectedOccupancies.push(staffIntervals);

        resourceId = activeResourceIds.find((candidateId) => {
          const intervals = resourceOccupancy.get(candidateId);
          return intervals && !intervals.some(([occupiedStart, occupiedEnd]) => (
            overlaps(startMs, endMs, occupiedStart, occupiedEnd)
          ));
        }) ?? null;
        const resourceIntervals = resourceId ? resourceOccupancy.get(resourceId) : undefined;
        if (!resourceIntervals) { skipped++; continue; }
        selectedOccupancies.push(resourceIntervals);
      }
    } else {
      staffId = tmToStaff.get(teamMemberId) ?? null;
      const staffIntervals = staffId ? staffOccupancy.get(staffId) : undefined;
      if (!staffIntervals || ambiguousStaffTeamMembers.has(teamMemberId)) {
        skipped++;
        continue;
      }
      selectedOccupancies.push(staffIntervals);
    }
    if (selectedOccupancies.some((intervals) => intervals.some(([
      occupiedStart,
      occupiedEnd,
    ]) => (
        overlaps(startMs, endMs, occupiedStart, occupiedEnd)
      )))) {
      skipped++;
      continue;
    }

    // Resolve/import a client only after all pull-create, location, status and
    // capacity gates pass. A disabled or rejected import must be mutation-free.
    const client = await resolveSquareClient(b.customer_id);

    const { data: insRow, error } = await db.from("bookings").insert({
      salon_id: salonId,
      service_id: svc.id,
      staff_id: staffId,
      resource_id: resourceId,
      client_profile_id: client?.clientProfileId ?? null,
      client_name: client?.name || "Square Guest",
      client_phone: client?.phone ?? null,
      start_time_utc: new Date(startMs).toISOString(),
      end_time_utc: new Date(endMs).toISOString(),
      status: targetStatus,
      source: "appointment",
      // booking_channel not yet in generated types — cast below.
      booking_channel: "square",
      price_cents: svc.price_cents,
      square_booking_id: b.id,
    } as never).select("id").maybeSingle();
    if (error) {
      if (expectedInboundBookingInsertConflict(error)) {
        // A concurrent importer or capacity writer won after our read. The DB
        // remains authoritative and the next pull re-reads that state.
        skipped++;
        continue;
      }
      const code = databaseErrorCode(error);
      // Do not clear square_integrations.last_error after an unexpected
      // schema/RLS/connectivity failure. The cron boundary records this stable,
      // PII-free code and leaves the salon visibly unhealthy for operators.
      throw new Error(`square_sync_booking_insert_failed:${code}`);
    }
    for (const intervals of selectedOccupancies) intervals.push([startMs, endMs]);
    inserted++;

    // Owner/admin "new booking" alert — only future bookings, capped per run so
    // a bulk historical import can't blast a storm of emails.
    const newId = (insRow as { id?: string } | null)?.id;
    if (newId && startMs > Date.now() && ownerNotifyCount < OWNER_NOTIFY_CAP) {
      ownerNotifyCount++;
      after(() =>
        sendOwnerBookingNotification({
          salonId,
          bookingId: String(newId),
          event: "new",
        }),
      );
    }
  }

  // ── Reverse sync, Tầng 1: push NailIQ-side CANCELLATIONS to Square ─────────
  // A booking cancelled in NailIQ (desk/customer) but still ACTIVE in Square
  // would linger on the Square calendar → the slot looks taken there and a
  // double-booking can't be prevented. Mirror the cancel to Square. This never
  // fights the forward pull: a Square-origin cancel already shows CANCELLED_* in
  // the fetched list (skipped below), and once we cancel here the next pull is a
  // no-op (NailIQ is already cancelled). A failed cancel fails the run so the
  // integration health record cannot be cleared as successful.
  // Shared by the cancel + reschedule reverse passes: index the fetched Square
  // bookings + the "active in Square" set.
  const squareById = new Map<string, SquareBooking>();
  for (const booking of bookings) {
    if (booking.location_id === cfg.locationId) squareById.set(booking.id, booking);
  }

  let cancelledInSquare = 0;
  if (cfg.sync.pushCancel) {
  // Safety rail for a DESTRUCTIVE write: a data glitch that mass-marks bookings
  // cancelled must never mass-cancel a salon's real Square calendar. Cap pushes
  // per run far above the legit cancel rate in a 5-min window; if we hit it,
  // log loudly and stop (the rest retry next run once the anomaly is resolved).
  const MAX_CANCEL_PUSH_PER_RUN = 10;

  const { data: localCancels, error: localCancelsError } = await db
    .from("bookings")
    .select("id, square_booking_id")
    .eq("salon_id", salonId)
    .eq("status", "cancelled")
    .not("square_booking_id", "is", null)
    .gte("start_time_utc", begin.toISOString())
    .lt("start_time_utc", end.toISOString());
  if (localCancelsError) throw new Error("square_sync_cancel_inventory_unavailable");

  for (const r of localCancels ?? []) {
    const sqId = str(r.square_booking_id);
    const sq = squareById.get(sqId);
    if (!sq) continue; // not in the fetched window (gone / out of range)
    if (!ACTIVE_SQUARE.has(sq.status)) continue; // already cancelled/no-show in Square
    if (typeof sq.version !== "number") continue;
    if (cancelledInSquare >= MAX_CANCEL_PUSH_PER_RUN) {
      console.error(
        `[squareSync] cancel-push cap hit (${MAX_CANCEL_PUSH_PER_RUN}) for salon ${salonId} — possible anomaly, stopping this run`,
      );
      break;
    }
    try {
      await cancelSquareBooking(cfg, sqId, sq.version);
      cancelledInSquare++;
    } catch {
      // A provider failure must keep integration health red. Swallowing it here
      // would let the final cursor update erase the only operator-visible error.
      throw new Error("square_sync_cancel_push_failed");
    }
  }
  } // end push-cancel toggle

  // ── Reverse sync, Tầng 2: push NailIQ-CREATED bookings into Square (opt-in) ─
  // So a booking made in NailIQ (desk/online/group) also lands on the Square
  // calendar — otherwise the slot looks free there and Square can double-book it.
  // OFF by default (cfg.sync.pushCreate): a mirrored booking may trigger
  // Square's own customer confirmation, so the salon must align notification
  // settings first (else the guest is double-texted). square_booking_id IS NULL
  // ⟺ NailIQ-origin (Square-origin rows are always created WITH the id).
  let createdInSquare = 0;
  if (cfg.sync.pushCreate) {
    const MAX_CREATE_PUSH_PER_RUN = 10;
    const { data: toPush, error: toPushError } = await db
      .from("bookings")
      .select("id, salon_id, service_id, staff_id, client_name, client_phone, client_email, status, deleted_at, start_time_utc, end_time_utc")
      .eq("salon_id", salonId)
      .is("square_booking_id", null)
      .is("deleted_at", null)
      .in("status", ["confirmed", "pending"])
      .gt("start_time_utc", now.toISOString())
      .lt("start_time_utc", end.toISOString())
      .limit(50);
    if (toPushError) throw new Error("square_sync_create_inventory_unavailable");

    for (const r of toPush ?? []) {
      if (createdInSquare >= MAX_CREATE_PUSH_PER_RUN) {
        console.error(`[squareSync] create-push cap hit for salon ${salonId} — deferring rest to next run`);
        break;
      }
      const tmId = r.staff_id ? staffToTeamMember.get(str(r.staff_id)) : undefined;
      if (!tmId) { skipped++; continue; } // staff not linked to a Square team member
      const svcNorm = r.service_id ? serviceIdToNorm.get(str(r.service_id)) : undefined;
      const variation = svcNorm ? variationByNorm.get(svcNorm) : undefined;
      if (!variation) { skipped++; continue; } // service not mappable to a Square variation
      const snapshot = snapshotFromRow(r, salonId);
      if (!snapshot) { skipped++; continue; }

      // Persist an exact, PII-free operation before the first provider call.
      // Once dispatch begins, any ambiguous response is reconciliation-only:
      // a later cron may prove the provider receipt but may never blind-POST a
      // second booking under changed local/customer/account material.
      const claim = await claimSquareBookingWriteback(db, cfg, {
        bookingId: snapshot.id,
        serviceId: snapshot.serviceId,
        serviceMappingBasis: svcNorm!,
        staffId: snapshot.staffId,
        status: snapshot.status,
        startTimeUtc: snapshot.startTimeUtc,
        endTimeUtc: snapshot.endTimeUtc,
        teamMemberId: tmId,
        serviceVariationId: variation.variationId,
        serviceVariationVersion: variation.version,
        clientName: str(r.client_name) || null,
        clientPhone: str(r.client_phone) || null,
        clientEmail: str(r.client_email) || null,
      });
      let customerId: string | null = null;
      let created: { id: string; version: number } | null = null;
      let failureCode = "square_writeback_dispatch_failed";
      try {
        const dispatch = await beginSquareBookingWritebackDispatch(db, cfg, claim);
        failureCode = "square_customer_resolution_unknown";
        customerId = await ensureSquareCustomer(cfg, {
          name: dispatch.clientName || null,
          phone: dispatch.clientPhone,
          email: dispatch.clientEmail,
          referenceId: dispatch.customerReferenceId,
          idempotencyKey: dispatch.material.customerIdempotencyKey,
        });
        failureCode = "square_customer_receipt_write_failed";
        await recordSquareBookingWritebackCustomer(db, dispatch, customerId);
        failureCode = "square_booking_create_outcome_unknown";
        created = await createSquareBooking(cfg, {
          startAtIso: new Date(Date.parse(dispatch.material.startTimeUtc)).toISOString(),
          customerId,
          teamMemberId: dispatch.material.teamMemberId,
          serviceVariationId: dispatch.material.serviceVariationId,
          serviceVariationVersion: dispatch.material.serviceVariationVersion,
          durationMinutes: dispatch.material.durationMinutes,
          sellerNote: dispatch.sellerNote,
          idempotencyKey: dispatch.material.bookingIdempotencyKey,
        });
        failureCode = "square_booking_bind_outcome_unknown";
        await completeSquareBookingWritebackSuccess(db, dispatch, {
          providerBookingId: created.id,
          providerCustomerId: customerId,
          providerBookingVersion: created.version,
        });
      } catch (error) {
        try {
          await markSquareBookingWritebackUnknown(
            db,
            claim,
            failureCode,
            {
              providerBookingId: created?.id ?? null,
              providerCustomerId: customerId,
              providerBookingVersion: created?.version ?? null,
            },
          );
        } catch (markError) {
          // Response loss here cannot safely downgrade the original failure.
          // The durable state remains claimed/sending/unknown and the next run
          // is still reconciliation-only; retain a non-PII diagnostic locally.
          console.error(
            "[squareSync] writeback unknown-state receipt failed",
            snapshot.id,
            markError instanceof Error ? markError.message : "unknown",
          );
        }
        throw new Error(failureCode, { cause: error });
      }
      createdInSquare++;
    }
  }

  // ── Reverse sync, Tầng 3: push NailIQ RESCHEDULES to Square (opt-in) ───────
  // When a Square-linked booking is moved in NailIQ (desk drag / customer /
  // voice) more recently than Square's own last edit, carry the new time TO
  // Square via UpdateBooking. Last-writer-wins (local edit vs Square updated_at)
  // is the SAME comparison the forward pull uses, so the two never ping-pong:
  // the side that edited last owns the slot.
  let updatedInSquare = 0;
  if (cfg.sync.pushUpdate) {
    const MAX_UPDATE_PUSH_PER_RUN = 10;
    const { data: linked, error: linkedError } = await db
      .from("bookings")
      .select("id, square_booking_id, start_time_utc, end_time_utc, local_updated_at, rescheduled_at")
      .eq("salon_id", salonId)
      .not("square_booking_id", "is", null)
      .in("status", ["confirmed", "pending"])
      .gte("start_time_utc", begin.toISOString())
      .lt("start_time_utc", end.toISOString());
    if (linkedError) throw new Error("square_sync_reschedule_inventory_unavailable");

    for (const r of linked ?? []) {
      if (updatedInSquare >= MAX_UPDATE_PUSH_PER_RUN) {
        console.error(`[squareSync] reschedule-push cap hit for salon ${salonId} — deferring rest`);
        break;
      }
      const sq = squareById.get(str(r.square_booking_id));
      if (!sq || !ACTIVE_SQUARE.has(sq.status) || typeof sq.version !== "number") continue;
      const seg = sq.appointment_segments?.[0];
      if (!seg?.team_member_id || !seg.service_variation_id || typeof seg.service_variation_version !== "number") continue;

      const localEditMs = Math.max(
        r.local_updated_at ? Date.parse(str(r.local_updated_at)) : 0,
        r.rescheduled_at ? Date.parse(str(r.rescheduled_at)) : 0,
      );
      const squareUpdatedMs = sq.updated_at ? Date.parse(sq.updated_at) : 0;
      if (!(localEditMs > squareUpdatedMs)) continue; // Square owns it (or no local edit)

      const nailStartMs = Date.parse(str(r.start_time_utc));
      if (!Number.isFinite(nailStartMs)) continue;
      if (sq.start_at && Date.parse(sq.start_at) === nailStartMs) continue; // already in sync
      const durMin = Math.max(5, Math.round((Date.parse(str(r.end_time_utc)) - nailStartMs) / 60_000));
      try {
        await updateSquareBookingTime(cfg, {
          bookingId: sq.id,
          version: sq.version,
          startAtIso: new Date(nailStartMs).toISOString(),
          teamMemberId: seg.team_member_id,
          serviceVariationId: seg.service_variation_id,
          serviceVariationVersion: seg.service_variation_version,
          durationMinutes: durMin,
        });
        updatedInSquare++;
      } catch {
        throw new Error("square_sync_reschedule_push_failed");
      }
    }
  }

  const { error: healthUpdateError } = await db.from("square_integrations").update({
    cursor_synced_at: now.toISOString(),
    last_run_at: now.toISOString(),
    last_error: null,
  }).eq("salon_id", salonId);
  if (healthUpdateError) throw new Error("square_sync_health_update_failed");

  return { pulled: bookings.length, inserted, updated, customersAdded, skipped, cancelledInSquare, createdInSquare, updatedInSquare };
}
