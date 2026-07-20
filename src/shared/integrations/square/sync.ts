/**
 * Square -> NailIQ forward sync (stateless; called by the Vercel cron).
 *
 * Each run pulls the location's bookings in a rolling window (yesterday ..
 * +90 days) and reconciles them into NailIQ:
 *   - new active booking      -> insert, assigned to its Square bed's NailIQ
 *                                staff (square_team_member_id link) or any free
 *                                column (so it renders + never violates the
 *                                bookings_no_overlap GIST).
 *   - status/time change      -> update the existing row (cancellations,
 *                                reschedules, no-shows reflected on the calendar).
 *   - unknown customer        -> fetched on demand and inserted into
 *                                client_profiles (canonical phone), so returning
 *                                customers are recognised.
 *
 * Idempotent on bookings.square_booking_id / client_profiles.square_customer_id.
 * ListBookings has no "updated since" filter, so we re-scan the forward window
 * each run and upsert; the watermark is advanced for observability only.
 */
import { after } from "next/server";
import "server-only";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
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

const RENDER_STATUS = new Set(["pending", "confirmed", "in_progress", "completed"]);
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
  const { data } = await db
    .from("bookings")
    .select("staff_id, status")
    .eq("salon_id", salonId)
    .not("id", "eq", excludeBookingId)
    .not("staff_id", "is", null)
    .lt("start_time_utc", new Date(endMs).toISOString())
    .gt("end_time_utc", new Date(startMs).toISOString());
  const busy = new Set<string>();
  for (const r of data ?? []) if (RENDER_STATUS.has(str(r.status))) busy.add(str(r.staff_id));
  for (const sid of activeStaff) if (!busy.has(sid)) return sid;
  return null;
}

export async function runSquareForwardSync(salonId: string): Promise<SquareSyncResult> {
  const db = looseServiceClient();
  const cfg = await getSquareConfig(db, salonId);

  const now = new Date();
  const begin = new Date(now.getTime() - 86_400_000);
  const end = new Date(now.getTime() + 90 * 86_400_000);
  const bookings = (await listBookings(cfg, begin, end)) as SquareBooking[];

  // service variation -> NailIQ service
  const items = await listCatalogItems(cfg);
  const variationToItemName = new Map<string, string>();
  for (const it of items) for (const v of it.variations) variationToItemName.set(v.id, it.name);
  const { data: svcRows } = await db.from("services").select("id, name, price_cents").eq("salon_id", salonId).is("deleted_at", null);
  const svcByNorm = new Map<string, { id: string; price_cents: number }>();
  for (const s of svcRows ?? []) svcByNorm.set(norm(str(s.name)), { id: str(s.id), price_cents: Number(s.price_cents) });

  // staff: square bed link + occupancy for free-column fallback
  const { data: staffRows } = await db.from("staff").select("id, square_team_member_id").eq("salon_id", salonId).eq("status", "active").is("deleted_at", null);
  const activeStaff: string[] = (staffRows ?? []).map((s) => str(s.id));
  const tmToStaff = new Map<string, string>();
  for (const s of staffRows ?? []) if (s.square_team_member_id) tmToStaff.set(str(s.square_team_member_id), str(s.id));

  const occ = new Map<string, [number, number][]>();
  for (const id of activeStaff) occ.set(id, []);
  const { data: occRows } = await db
    .from("bookings").select("staff_id, start_time_utc, end_time_utc, status")
    .eq("salon_id", salonId).not("staff_id", "is", null).gte("start_time_utc", begin.toISOString()).lt("start_time_utc", end.toISOString());
  for (const r of occRows ?? [])
    if (RENDER_STATUS.has(str(r.status)) && occ.has(str(r.staff_id))) occ.get(str(r.staff_id))!.push([Date.parse(str(r.start_time_utc)), Date.parse(str(r.end_time_utc))]);

  let inserted = 0, updated = 0, customersAdded = 0, skipped = 0;
  // Owner-notify guard: cap emails per sync run so a bulk import can't storm.
  const OWNER_NOTIFY_CAP = 5;
  let ownerNotifyCount = 0;
  const clientCache = new Map<string, { name: string | null; phone: string | null }>();

  for (const b of bookings) {
    const seg = b.appointment_segments?.[0];
    const itemName = seg?.service_variation_id ? variationToItemName.get(seg.service_variation_id) : undefined;
    const svc = itemName ? svcByNorm.get(norm(itemName)) : undefined;
    if (!svc || !b.start_at) { skipped++; continue; }

    const targetStatus = STATUS_MAP[b.status] ?? "completed";

    // resolve / import client
    let client = b.customer_id ? clientCache.get(b.customer_id) : undefined;
    if (!client && b.customer_id) {
      const { data: existingClient } = await db.from("client_profiles").select("name, phone").eq("square_customer_id", b.customer_id).maybeSingle();
      if (existingClient) {
        client = { name: existingClient.name ? str(existingClient.name) : null, phone: existingClient.phone ? str(existingClient.phone) : null };
      } else {
        const sc = await getCustomer(cfg, b.customer_id);
        const phone = toCanonicalPhone(sc?.phone_number);
        const nm = safeName([sc?.given_name ?? "", sc?.family_name ?? ""].join(" "));
        if (sc && phone) {
          // Returning customer may already exist by phone (from the backfill) but
          // unlinked — link it (set square_customer_id) instead of re-fetching forever.
          const { data: byPhone } = await db.from("client_profiles").select("id, name, square_customer_id").eq("phone", phone).maybeSingle();
          if (byPhone) {
            if (!byPhone.square_customer_id) await db.from("client_profiles").update({ square_customer_id: sc.id }).eq("id", str(byPhone.id));
            client = { name: byPhone.name ? str(byPhone.name) : nm || null, phone };
          } else {
            await db.from("client_profiles").insert({ phone, name: nm || null, email: (sc.email_address ?? "").trim().toLowerCase() || null, square_customer_id: sc.id });
            customersAdded++;
            client = { name: nm || null, phone };
          }
        } else {
          client = { name: nm || null, phone };
        }
      }
      clientCache.set(b.customer_id, client);
    }

    const durMin = (b.appointment_segments ?? []).reduce((s, x) => s + (x.duration_minutes ?? 0), 0) || 60;
    const startMs = Date.parse(b.start_at);
    const endMs = startMs + durMin * 60_000;

    const { data: existing } = await db
      .from("bookings")
      .select("id, status, start_time_utc, end_time_utc, staff_id, local_updated_at, rescheduled_at")
      .eq("square_booking_id", b.id)
      .maybeSingle();

    if (existing) {
      // The desk owns the workflow status once a booking has been started,
      // completed, or no-showed in NailIQ — Square (which only knows ACCEPTED)
      // must NOT clobber it back to "confirmed" on the next sync. (Bug: a
      // receptionist-completed Square booking reverted to "not started".)
      // Square's own state still applies while the booking is pending/confirmed.
      const localStatus = str(existing.status);
      const existingId = str(existing.id);
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
          // A time move can collide with another booking on the same bed
          // (bookings_no_overlap GIST → 23P01). Re-home it to any active bed
          // free at the NEW slot; if none, leave the row as-is (never crash the
          // whole sync run for one conflict).
          if (updates.start_time_utc) {
            const freeStaff = await findFreeStaffForInterval(
              db, salonId, activeStaff, startMs, endMs, existingId,
            );
            if (freeStaff) {
              const { error: e2 } = await db
                .from("bookings")
                .update({ ...updates, staff_id: freeStaff })
                .eq("id", existingId);
              if (!e2) updated++;
              else skipped++;
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

    const preferred = seg?.team_member_id ? tmToStaff.get(seg.team_member_id) : undefined;
    const order = preferred ? [preferred, ...activeStaff.filter((x) => x !== preferred)] : activeStaff;
    let staffId: string | null = null;
    for (const sid of order) {
      const iv = occ.get(sid)!;
      if (!iv.some(([os, oe]) => overlaps(startMs, endMs, os, oe))) { staffId = sid; iv.push([startMs, endMs]); break; }
    }
    if (!staffId) { skipped++; continue; } // > all beds busy

    const { data: insRow, error } = await db.from("bookings").insert({
      salon_id: salonId,
      service_id: svc.id,
      staff_id: staffId,
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
    if (error) { skipped++; continue; }
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
  // no-op (NailIQ is already cancelled). One failed cancel is logged, not fatal.
  // Shared by the cancel + reschedule reverse passes: index the fetched Square
  // bookings + the "active in Square" set.
  const ACTIVE_SQUARE = new Set(["ACCEPTED", "PENDING"]);
  const squareById = new Map<string, SquareBooking>();
  for (const b of bookings) squareById.set(b.id, b);

  let cancelledInSquare = 0;
  if (cfg.sync.pushCancel) {
  // Safety rail for a DESTRUCTIVE write: a data glitch that mass-marks bookings
  // cancelled must never mass-cancel a salon's real Square calendar. Cap pushes
  // per run far above the legit cancel rate in a 5-min window; if we hit it,
  // log loudly and stop (the rest retry next run once the anomaly is resolved).
  const MAX_CANCEL_PUSH_PER_RUN = 10;

  const { data: localCancels } = await db
    .from("bookings")
    .select("id, square_booking_id")
    .eq("salon_id", salonId)
    .eq("status", "cancelled")
    .not("square_booking_id", "is", null)
    .gte("start_time_utc", begin.toISOString())
    .lt("start_time_utc", end.toISOString());

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
    } catch (e) {
      console.error("[squareSync] cancel push failed", sqId, e);
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
    // NailIQ service → Square variation (by normalized item name, first match) + version.
    const varByNorm = new Map<string, { variationId: string; version: number }>();
    for (const it of items) {
      const n = norm(it.name);
      if (varByNorm.has(n)) continue;
      const v = it.variations.find((x) => typeof x.version === "number");
      if (v && typeof v.version === "number") varByNorm.set(n, { variationId: v.id, version: v.version });
    }
    const svcIdToNorm = new Map<string, string>();
    for (const s of svcRows ?? []) svcIdToNorm.set(str(s.id), norm(str(s.name)));
    const staffToTm = new Map<string, string>();
    for (const s of staffRows ?? []) if (s.square_team_member_id) staffToTm.set(str(s.id), str(s.square_team_member_id));

    const { data: toPush } = await db
      .from("bookings")
      .select("id, service_id, staff_id, client_name, client_phone, client_email, start_time_utc, end_time_utc")
      .eq("salon_id", salonId)
      .is("square_booking_id", null)
      .in("status", ["confirmed", "pending"])
      .gt("start_time_utc", now.toISOString())
      .lt("start_time_utc", end.toISOString())
      .limit(50);

    for (const r of toPush ?? []) {
      if (createdInSquare >= MAX_CREATE_PUSH_PER_RUN) {
        console.error(`[squareSync] create-push cap hit for salon ${salonId} — deferring rest to next run`);
        break;
      }
      const tmId = r.staff_id ? staffToTm.get(str(r.staff_id)) : undefined;
      if (!tmId) { skipped++; continue; } // staff not linked to a Square team member
      const svcNorm = r.service_id ? svcIdToNorm.get(str(r.service_id)) : undefined;
      const variation = svcNorm ? varByNorm.get(svcNorm) : undefined;
      if (!variation) { skipped++; continue; } // service not mappable to a Square variation
      const startMsR = Date.parse(str(r.start_time_utc));
      const durMin = Math.max(5, Math.round((Date.parse(str(r.end_time_utc)) - startMsR) / 60_000));
      try {
        const customerId = await ensureSquareCustomer(cfg, {
          name: str(r.client_name) || null,
          phone: str(r.client_phone) || null,
          email: str(r.client_email) || null,
          referenceId: `booking:${str(r.id)}`,
          idempotencyKey: `sqcust:${str(r.id)}`,
        });
        const created = await createSquareBooking(cfg, {
          startAtIso: new Date(startMsR).toISOString(),
          customerId,
          teamMemberId: tmId,
          serviceVariationId: variation.variationId,
          serviceVariationVersion: variation.version,
          durationMinutes: durMin,
          sellerNote: "Đặt từ NailIQ",
          idempotencyKey: `create:${str(r.id)}`, // stable → Square dedups a retry
        });
        await db.from("bookings").update({ square_booking_id: created.id } as never).eq("id", str(r.id));
        createdInSquare++;
      } catch (e) {
        console.error("[squareSync] create push failed", str(r.id), e);
        skipped++;
      }
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
    const { data: linked } = await db
      .from("bookings")
      .select("id, square_booking_id, start_time_utc, end_time_utc, local_updated_at, rescheduled_at")
      .eq("salon_id", salonId)
      .not("square_booking_id", "is", null)
      .in("status", ["confirmed", "pending"])
      .gte("start_time_utc", begin.toISOString())
      .lt("start_time_utc", end.toISOString());

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
      } catch (e) {
        console.error("[squareSync] reschedule push failed", str(r.id), e);
      }
    }
  }

  await db.from("square_integrations").update({
    cursor_synced_at: now.toISOString(),
    last_run_at: now.toISOString(),
    last_error: null,
  }).eq("salon_id", salonId);

  return { pulled: bookings.length, inserted, updated, customersAdded, skipped, cancelledInSquare, createdInSquare, updatedInSquare };
}
