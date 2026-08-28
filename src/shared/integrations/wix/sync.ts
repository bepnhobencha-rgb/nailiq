/**
 * Wix → NailIQ forward sync (one pass). Driven by the `/api/cron/wix-sync` route.
 *
 * Idempotent via `bookings.wix_booking_id`. Stateless: the watermark lives in
 * `wix_integrations.cursor_updated_date`, so it is safe to run on Vercel cron.
 */
import { after } from "next/server";
import "server-only";
import { queryBookingsUpdatedSince, type WixBooking } from "./client";
import { looseServiceClient } from "./looseDb";
import { pushWixConfirm } from "./writeback";
import { categorizeService } from "./categorize";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import { parseWixBookingWindow } from "./bookingWindow";
import {
  bookingChannelFor,
  runBookingOrchestrator,
} from "@/shared/booking/bookingOrchestrator";

const WIX_BOOKING_CHANNEL = bookingChannelFor({
  gateway: "wix",
  intent: "external_import",
  operation: "reconcile",
});

// --- pure helpers ---
function canonPhone(p: unknown): string | null {
  // Was: "+1" + last10 — corrupted international numbers (e.g. VN +84) and
  // stored a leading "+". Use the shared canonical normalizer so Wix-imported
  // contacts match the same format every other write path produces.
  return toCanonicalPhone(p == null ? null : String(p));
}
const titleCase = (s: string) =>
  s.replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase()).trim();
function sanitizeName(s: unknown): string | null {
  if (!s) return null;
  const c = String(s).replace(/[<>{}=&;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return c || null;
}
const normKey = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const staffNum = (name: string): number | null => {
  const m = String(name || "").match(/#\s*(\d+)/);
  return m ? Number(m[1]) : null;
};
// Wix anonymises techs as "Staff Member #N" and never exposes real names via API. We deliberately
// DO NOT fabricate names (customer notes proved too noisy — they name whoever the customer *wanted*,
// not who was assigned). Use a neutral "Thợ #N" label; the owner renames once in Settings. Identity
// is keyed on the stable Wix resource UUID (staff.wix_resource_id), so a rename never breaks links.
const neutralStaffLabel = (wixName: string): string => {
  const n = staffNum(wixName);
  return n != null ? `Thợ ${n}` : (sanitizeName(wixName) ?? "Thợ mới");
};

/**
 * Wix PENDING/CREATED → 'confirmed' is WRONG (loses the "needs approval" signal); but plain
 * 'pending' gets auto-killed by the `release-pending` cron. So we keep 'pending' AND stamp
 * verification_method='none' (see row build) so that cron skips it. CONFIRMED-past → completed.
 */
function mapStatus(wix: string, startMs: number, now: number): string {
  const s = (wix || "").toUpperCase();
  if (s === "CANCELED" || s === "CANCELLED" || s === "DECLINED") return "cancelled";
  if (s === "CONFIRMED" && startMs < now) return "completed";
  if (s === "CONFIRMED") return "confirmed";
  return "pending";
}
const noteRequestsStaff = (note: string | null) =>
  !!note && /\b(with|please|for|request|book)\b/i.test(note);

/**
 * Mirror of the SQL `compute_no_show_risk(p_no_show_count, p_visit_count, p_subtotal_cents)`
 * so the Wix sync can risk-score a booking without an RPC round-trip. Keep in lockstep with
 * supabase/migrations/20260523000000_smart_booking_verification.sql.
 */
function computeNoShowRisk(noShows: number, visits: number, subtotalCents: number): number {
  let s = 30; // baseline: new customer
  if (noShows >= 3) s += 40;
  else if (noShows === 2) s += 30;
  else if (noShows === 1) s += 20;
  if (visits === 0) s += 15;
  else if (visits >= 10) s -= 25;
  else if (visits >= 5) s -= 15;
  else if (visits >= 2) s -= 5;
  if (subtotalCents >= 15000) s -= 10;
  return Math.max(0, Math.min(100, s));
}

type ForwardSyncResult = { created: number; updated: number; skipped: number; autoApproved: number; cursor: string };
type BookingEventResult = { action: "inserted" | "updated" | "skipped"; bookingId?: string; startUtc?: string };

// --------------------------------------------------------------------------
// Resolver context — built once per sync run and shared across all bookings.
// Extracted so processWixBookingEvent can also build its own (smaller) context
// when called from the webhook handler without a full batch run.
// --------------------------------------------------------------------------
interface ResolverContext {
  db: ReturnType<typeof looseServiceClient>;
  salonId: string;
  svcByName: Map<string, { id: string; price: number }>;
  staffByResource: Map<string, string>;
  staffByName: Map<string, string>;
  otpThreshold: number;
  autoApprove: boolean;
}

async function buildResolverContext(salonId: string, autoApprove: boolean): Promise<ResolverContext> {
  const db = looseServiceClient();
  const { data: svcRows } = await db.from("services").select("id,name,duration_minutes,price_cents").eq("salon_id", salonId);
  const svcByName = new Map<string, { id: string; price: number }>(
    (svcRows ?? []).map((s): [string, { id: string; price: number }] => [normKey(s.name), { id: s.id as string, price: (s.price_cents as number) ?? 0 }]),
  );
  const { data: staffRows } = await db.from("staff").select("id,name,wix_resource_id").eq("salon_id", salonId);
  const staffByResource = new Map<string, string>(
    (staffRows ?? []).filter((s) => s.wix_resource_id).map((s): [string, string] => [s.wix_resource_id as string, s.id as string]),
  );
  const staffByName = new Map<string, string>(
    (staffRows ?? []).map((s): [string, string] => [normKey(s.name), s.id as string]),
  );
  const { data: salonRow } = await db.from("salons").select("verification_risk_threshold_otp").eq("id", salonId).maybeSingle();
  const otpThreshold = Number((salonRow?.verification_risk_threshold_otp as number) ?? 30);
  return { db, salonId, svcByName, staffByResource, staffByName, otpThreshold, autoApprove };
}

async function resolveService(ctx: ResolverContext, title: string, durMin: number, wixServiceId?: string | null, wixScheduleId?: string | null) {
  const hit = ctx.svcByName.get(normKey(title));
  if (hit) return hit;
  const insertPayload: Record<string, unknown> = {
    salon_id: ctx.salonId,
    name: titleCase(title || "Service"),
    price_cents: 0,
    duration_minutes: Math.max(15, durMin),
    category: categorizeService(title),
  };
  if (wixServiceId)  insertPayload.wix_service_id  = wixServiceId;
  if (wixScheduleId) insertPayload.wix_schedule_id = wixScheduleId;
  const { data } = await ctx.db.from("services").insert(insertPayload as never).select("id").single();
  const rec = { id: data?.id as string, price: 0 };
  ctx.svcByName.set(normKey(title), rec);
  return rec;
}

async function resolveStaff(ctx: ResolverContext, resourceId: string | null | undefined, wixName: string): Promise<string | null> {
  if (resourceId) {
    const hit = ctx.staffByResource.get(resourceId);
    if (hit) return hit;
  }
  const label = neutralStaffLabel(wixName);
  if (resourceId) {
    const { data } = await ctx.db
      .from("staff")
      .insert({ salon_id: ctx.salonId, name: label, job_role: "nail_tech", status: "active", wix_resource_id: resourceId })
      .select("id")
      .single();
    const newId = data?.id as string | undefined;
    if (newId) { ctx.staffByResource.set(resourceId, newId); ctx.staffByName.set(normKey(label), newId); }
    return newId ?? null;
  }
  const hit = ctx.staffByName.get(normKey(label));
  if (hit) return hit;
  const { data } = await ctx.db.from("staff").insert({ salon_id: ctx.salonId, name: label, job_role: "nail_tech", status: "active" }).select("id").single();
  const newId = data?.id as string | undefined;
  if (newId) ctx.staffByName.set(normKey(label), newId);
  return newId ?? null;
}

async function evaluateClient(ctx: ResolverContext, phone: string, subtotalCents: number): Promise<{ risk: number; approve: boolean }> {
  const { data: c } = await ctx.db.from("client_profiles").select("is_vip, visit_count, no_show_count").eq("phone", phone).maybeSingle();
  const vip = c?.is_vip === true;
  const visits = Number((c?.visit_count as number) ?? 0);
  const noShows = Number((c?.no_show_count as number) ?? 0);
  if (vip) return { risk: 0, approve: true };
  if (visits >= 5 && noShows === 0) return { risk: 0, approve: true };
  const risk = computeNoShowRisk(noShows, visits, subtotalCents);
  return { risk, approve: risk < ctx.otpThreshold };
}

/**
 * Process a single Wix extended booking object and upsert it into NailIQ's bookings table.
 * Exported so the webhook handler can call it without going through a full batch sync.
 * The resolver context is built fresh on each webhook call (small overhead, isolated per event).
 */
async function executeWixBookingEvent(salonId: string, b: WixBooking, autoApprove = true): Promise<BookingEventResult> {
  const ctx = await buildResolverContext(salonId, autoApprove);
  return _processOne(ctx, b);
}

export async function processWixBookingEvent(
  ...args: Parameters<typeof executeWixBookingEvent>
): Promise<Awaited<ReturnType<typeof executeWixBookingEvent>>> {
  return runBookingOrchestrator(
    { gateway: "wix", intent: "external_import", operation: "reconcile" },
    () => executeWixBookingEvent(...args),
  );
}

/** Internal: process one booking using a pre-built resolver context (reused across the batch loop). */
async function _processOne(ctx: ResolverContext, b: WixBooking): Promise<BookingEventResult & { autoConfirmed: boolean }> {
  const now = Date.now();
  const window = parseWixBookingWindow({
    startDate: b.startDate,
    slotStartDate: b.bookedEntity?.slot?.startDate,
    endDate: b.endDate,
    slotEndDate: b.bookedEntity?.slot?.endDate,
  });
  if (!window) return { action: "skipped", autoConfirmed: false };
  const { startUtc: start, endUtc: end, durationMinutes } = window;
  const svc = await resolveService(
    ctx,
    b.bookedEntity?.title ?? "Service",
    durationMinutes,
    b.bookedEntity?.slot?.serviceId,
    b.bookedEntity?.slot?.scheduleId,
  );
  const staffId = await resolveStaff(ctx, b.bookedEntity?.slot?.resource?.id, b.bookedEntity?.slot?.resource?.name ?? "");
  const ph = canonPhone(b.contactDetails?.phone);
  const note = (b.additionalFields ?? []).find((f) => f.label === "Add Your Message")?.value || null;
  let status = mapStatus(b.status, new Date(start).getTime(), now);
  const clientName = sanitizeName([b.contactDetails?.firstName, b.contactDetails?.lastName].filter(Boolean).join(" ")) || "Guest";

  if (ph) {
    await ctx.db.from("client_profiles").upsert(
      { phone: ph, name: clientName === "Guest" ? null : clientName, email: b.contactDetails?.email ?? null, updated_at: new Date().toISOString() },
      { onConflict: "phone" },
    );
  }

  let computedRisk: number | undefined;
  let autoConfirmed = false;
  if (status === "pending" && ph) {
    const ev = await evaluateClient(ctx, ph, svc.price);
    computedRisk = ev.risk;
    if (ctx.autoApprove && ev.approve) { status = "confirmed"; autoConfirmed = true; }
  }

  const fields: Record<string, unknown> = {
    salon_id: ctx.salonId, client_name: clientName, client_phone: ph, client_email: b.contactDetails?.email ?? null,
    service_id: svc.id, staff_id: staffId, start_time_utc: start, end_time_utc: end, status, source: "appointment",
    booking_channel: WIX_BOOKING_CHANNEL,
    price_cents: svc.price, staff_request_note: note, staff_requested_by_client: noteRequestsStaff(note),
    verification_method: "none",
    wix_booking_id: b.id,
  };
  if (computedRisk !== undefined) fields.no_show_risk_score = computedRisk;

  // Locate existing row: by wix_booking_id first, then natural-key fallback for un-tagged rows.
  let found = (await ctx.db.from("bookings").select("id, status").eq("wix_booking_id", b.id).maybeSingle()).data;
  if (!found) {
    let q = ctx.db.from("bookings").select("id, status").eq("salon_id", ctx.salonId).eq("start_time_utc", start).is("wix_booking_id", null);
    q = ph ? q.eq("client_phone", ph) : q.is("client_phone", null);
    found = (await q.limit(1).maybeSingle()).data;
  }
  const existingId = found?.id as string | undefined;

  // Preserve a desk-marked no-show: Wix has no concept of it.
  if (existingId && (found?.status as string) === "no_show") {
    return { action: "skipped", autoConfirmed: false };
  }

  let bookingId: string | undefined;
  let action: "inserted" | "updated" | "skipped";
  if (existingId) {
    const { error } = await ctx.db.from("bookings").update(fields).eq("id", existingId);
    if (error && staffId) await ctx.db.from("bookings").update({ ...fields, staff_id: null }).eq("id", existingId);
    bookingId = existingId;
    action = "updated";
  } else {
    const insertRow = { ...fields, no_show_risk_score: computedRisk ?? 8, created_at: new Date().toISOString() };
    let { data, error } = await ctx.db.from("bookings").insert(insertRow).select("id").single();
    if (error && staffId) ({ data, error } = await ctx.db.from("bookings").insert({ ...insertRow, staff_id: null }).select("id").single());
    if (error) { action = "skipped"; }
    else { bookingId = data?.id as string | undefined; action = "inserted"; }
  }

  return { action, bookingId, autoConfirmed, startUtc: start };
}

async function executeForwardSync(salonId: string, siteId: string, sinceIso: string, autoApprove: boolean): Promise<ForwardSyncResult> {
  const ctx = await buildResolverContext(salonId, autoApprove);
  const bookings = await queryBookingsUpdatedSince(siteId, sinceIso);
  let created = 0, updated = 0, skipped = 0, autoApproved = 0, maxUpdated = sinceIso;
  // Owner-notify guard: cap emails per sync run so a bulk import can't storm.
  const OWNER_NOTIFY_CAP = 5;
  let ownerNotifyCount = 0;

  for (const b of bookings) {
    const result = await _processOne(ctx, b);
    if (result.action === "inserted") created++;
    else if (result.action === "updated") updated++;
    else skipped++;

    // Owner/admin "new booking" alert — only newly-inserted future bookings,
    // capped per run.
    if (
      result.action === "inserted" &&
      result.bookingId &&
      result.startUtc &&
      Date.parse(result.startUtc) > Date.now() &&
      ownerNotifyCount < OWNER_NOTIFY_CAP
    ) {
      ownerNotifyCount++;
      // Bind before the closure: `result` is reassigned each loop iteration, so
      // the narrowing above does not survive into the deferred callback.
      const notifyBookingId = result.bookingId;
      after(() =>
        sendOwnerBookingNotification({
          salonId,
          bookingId: notifyBookingId,
          event: "new",
        }),
      );
    }

    // Auto-approve write-back: confirm on Wix (best-effort).
    if (result.autoConfirmed && result.bookingId) { autoApproved++; void pushWixConfirm(salonId, result.bookingId); }

    if (b.updatedDate && b.updatedDate > maxUpdated) maxUpdated = b.updatedDate;
  }

  const newCursor = new Date(new Date(maxUpdated).getTime() + 1).toISOString();
  await ctx.db.from("wix_integrations").update({ cursor_updated_date: newCursor, last_run_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("salon_id", salonId);
  return { created, updated, skipped, autoApproved, cursor: newCursor };
}

export async function runForwardSync(
  ...args: Parameters<typeof executeForwardSync>
): Promise<Awaited<ReturnType<typeof executeForwardSync>>> {
  return runBookingOrchestrator(
    { gateway: "wix", intent: "external_import", operation: "reconcile" },
    () => executeForwardSync(...args),
  );
}
