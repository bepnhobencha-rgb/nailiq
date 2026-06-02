/**
 * Wix → NailIQ forward sync (one pass). Driven by the `/api/cron/wix-sync` route.
 *
 * Idempotent via `bookings.wix_booking_id`. Stateless: the watermark lives in
 * `wix_integrations.cursor_updated_date`, so it is safe to run on Vercel cron.
 */
import "server-only";
import { queryBookingsUpdatedSince } from "./client";
import { looseServiceClient } from "./looseDb";
import { pushWixConfirm } from "./writeback";
import { categorizeService } from "./categorize";

// --- pure helpers ---
function canonPhone(p: unknown): string | null {
  if (!p) return null;
  const d = String(p).replace(/\D/g, "");
  return d.length < 7 ? null : "+1" + d.slice(-10); // NANP
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
const minutesBetween = (a: string, b: string) =>
  Math.max(15, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));

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

export type ForwardSyncResult = { created: number; updated: number; skipped: number; autoApproved: number; cursor: string };

export async function runForwardSync(salonId: string, siteId: string, sinceIso: string, autoApprove: boolean): Promise<ForwardSyncResult> {
  // Loosely-typed handle: wix_booking_id column + wix_integrations table aren't in generated types yet.
  const db = looseServiceClient();

  // resolvers (cached per run)
  const { data: svcRows } = await db.from("services").select("id,name,duration_minutes,price_cents").eq("salon_id", salonId);
  const svcByName = new Map<string, { id: string; price: number }>(
    (svcRows ?? []).map((s): [string, { id: string; price: number }] => [normKey(s.name), { id: s.id as string, price: (s.price_cents as number) ?? 0 }]),
  );
  const { data: staffRows } = await db.from("staff").select("id,name,wix_resource_id").eq("salon_id", salonId);
  // Primary key = stable Wix resource UUID; name map is only a legacy fallback for resource-less rows.
  const staffByResource = new Map<string, string>(
    (staffRows ?? []).filter((s) => s.wix_resource_id).map((s): [string, string] => [s.wix_resource_id as string, s.id as string]),
  );
  const staffByName = new Map<string, string>(
    (staffRows ?? []).map((s): [string, string] => [normKey(s.name), s.id as string]),
  );

  // Smart auto-approve threshold (reuses the salon's existing OTP risk threshold).
  const { data: salonRow } = await db.from("salons").select("verification_risk_threshold_otp").eq("id", salonId).maybeSingle();
  const otpThreshold = Number((salonRow?.verification_risk_threshold_otp as number) ?? 30);

  /** Risk-score a client by phone and decide auto-approval (VIP / trusted returning / risk < threshold). */
  async function evaluateClient(phone: string, subtotalCents: number): Promise<{ risk: number; approve: boolean }> {
    const { data: c } = await db.from("client_profiles").select("is_vip, visit_count, no_show_count").eq("phone", phone).maybeSingle();
    const vip = c?.is_vip === true;
    const visits = Number((c?.visit_count as number) ?? 0);
    const noShows = Number((c?.no_show_count as number) ?? 0);
    if (vip) return { risk: 0, approve: true };
    if (visits >= 5 && noShows === 0) return { risk: 0, approve: true };
    const risk = computeNoShowRisk(noShows, visits, subtotalCents);
    return { risk, approve: risk < otpThreshold };
  }

  async function resolveService(title: string, durMin: number, wixServiceId?: string | null, wixScheduleId?: string | null) {
    const hit = svcByName.get(normKey(title));
    if (hit) return hit;
    const insertPayload: Record<string, unknown> = {
      salon_id: salonId,
      name: titleCase(title || "Service"),
      price_cents: 0,
      duration_minutes: Math.max(15, durMin),
      category: categorizeService(title),
    };
    // Store Wix IDs on new services so pushWixCreate can round-trip back later.
    if (wixServiceId)  insertPayload.wix_service_id  = wixServiceId;
    if (wixScheduleId) insertPayload.wix_schedule_id = wixScheduleId;
    const { data } = await db.from("services").insert(insertPayload as never).select("id").single();
    const rec = { id: data?.id as string, price: 0 };
    svcByName.set(normKey(title), rec);
    return rec;
  }
  async function resolveStaff(resourceId: string | null | undefined, wixName: string): Promise<string | null> {
    // 1. Stable identity: match on the Wix resource UUID — survives owner renames in NailIQ.
    if (resourceId) {
      const hit = staffByResource.get(resourceId);
      if (hit) return hit;
    }
    const label = neutralStaffLabel(wixName);
    // 2. New Wix resource → create a neutral-labelled staff row tagged with its resource UUID.
    if (resourceId) {
      const { data } = await db
        .from("staff")
        .insert({ salon_id: salonId, name: label, job_role: "nail_tech", status: "active", wix_resource_id: resourceId })
        .select("id")
        .single();
      const newId = data?.id as string | undefined;
      if (newId) { staffByResource.set(resourceId, newId); staffByName.set(normKey(label), newId); }
      return newId ?? null;
    }
    // 3. Booking carries no resource (rare) → fall back to name match, create if missing.
    const hit = staffByName.get(normKey(label));
    if (hit) return hit;
    const { data } = await db.from("staff").insert({ salon_id: salonId, name: label, job_role: "nail_tech", status: "active" }).select("id").single();
    const newId = data?.id as string | undefined;
    if (newId) staffByName.set(normKey(label), newId);
    return newId ?? null;
  }

  const bookings = await queryBookingsUpdatedSince(siteId, sinceIso);
  const now = Date.now();
  let created = 0, updated = 0, skipped = 0, autoApproved = 0, maxUpdated = sinceIso;

  for (const b of bookings) {
    const start = b.startDate ?? b.bookedEntity?.slot?.startDate;
    if (!start) { skipped++; continue; }
    const end = b.endDate ?? b.bookedEntity?.slot?.endDate ?? new Date(new Date(start).getTime() + 45 * 60000).toISOString();
    const svc = await resolveService(
      b.bookedEntity?.title ?? "Service",
      minutesBetween(start, end),
      b.bookedEntity?.slot?.serviceId,
      b.bookedEntity?.slot?.scheduleId,
    );
    const staffId = await resolveStaff(b.bookedEntity?.slot?.resource?.id, b.bookedEntity?.slot?.resource?.name ?? "");
    const ph = canonPhone(b.contactDetails?.phone);
    const note = (b.additionalFields ?? []).find((f) => f.label === "Add Your Message")?.value || null;
    let status = mapStatus(b.status, new Date(start).getTime(), now);
    const clientName = sanitizeName([b.contactDetails?.firstName, b.contactDetails?.lastName].filter(Boolean).join(" ")) || "Guest";

    if (ph) {
      await db.from("client_profiles").upsert(
        { phone: ph, name: clientName === "Guest" ? null : clientName, email: b.contactDetails?.email ?? null, updated_at: new Date().toISOString() },
        { onConflict: "phone" },
      );
    }

    // Smart auto-approve: risk-score a pending Wix request; auto-confirm the safe ones (and write
    // the Confirm back to Wix), leaving risky / new customers 'pending' for manual review.
    let computedRisk: number | undefined;
    let autoConfirmed = false;
    if (status === "pending" && ph) {
      const ev = await evaluateClient(ph, svc.price);
      computedRisk = ev.risk;
      if (autoApprove && ev.approve) { status = "confirmed"; autoConfirmed = true; }
    }

    const fields: Record<string, unknown> = {
      salon_id: salonId, client_name: clientName, client_phone: ph, client_email: b.contactDetails?.email ?? null,
      service_id: svc.id, staff_id: staffId, start_time_utc: start, end_time_utc: end, status, source: "appointment",
      price_cents: svc.price, staff_request_note: note, staff_requested_by_client: noteRequestsStaff(note),
      verification_method: "none", // shields synced 'pending' rows from the release-pending cron
      wix_booking_id: b.id,
    };
    if (computedRisk !== undefined) fields.no_show_risk_score = computedRisk;

    // Locate the existing row: by wix_booking_id first, then a natural-key fallback
    // (salon + start + phone, only rows not yet tagged) so we ADOPT backfilled rows
    // whose wix_booking_id is still NULL instead of inserting duplicates.
    let existingId = (await db.from("bookings").select("id").eq("wix_booking_id", b.id).maybeSingle()).data?.id as string | undefined;
    if (!existingId) {
      let q = db.from("bookings").select("id").eq("salon_id", salonId).eq("start_time_utc", start).is("wix_booking_id", null);
      q = ph ? q.eq("client_phone", ph) : q.is("client_phone", null);
      existingId = (await q.limit(1).maybeSingle()).data?.id as string | undefined;
    }
    let rowId: string | undefined;
    if (existingId) {
      const { error } = await db.from("bookings").update(fields).eq("id", existingId);
      if (error && staffId) await db.from("bookings").update({ ...fields, staff_id: null }).eq("id", existingId);
      rowId = existingId;
      updated++;
    } else {
      const insertRow = { ...fields, no_show_risk_score: computedRisk ?? 8, created_at: new Date().toISOString() };
      let { data, error } = await db.from("bookings").insert(insertRow).select("id").single();
      if (error && staffId) ({ data, error } = await db.from("bookings").insert({ ...insertRow, staff_id: null }).select("id").single());
      if (error) skipped++; else { rowId = data?.id as string | undefined; created++; }
    }

    // Auto-approve write-back: confirm on Wix (best-effort). Wix → CONFIRMED, so the next sync
    // reads it as confirmed and never re-approves — naturally idempotent.
    if (autoConfirmed && rowId) { autoApproved++; void pushWixConfirm(salonId, rowId); }

    if (b.updatedDate && b.updatedDate > maxUpdated) maxUpdated = b.updatedDate;
  }

  const newCursor = new Date(new Date(maxUpdated).getTime() + 1).toISOString();
  await db.from("wix_integrations").update({ cursor_updated_date: newCursor, last_run_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("salon_id", salonId);
  return { created, updated, skipped, autoApproved, cursor: newCursor };
}
