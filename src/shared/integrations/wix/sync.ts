/**
 * Wix → NailIQ forward sync (one pass). Driven by the `/api/cron/wix-sync` route.
 *
 * Idempotent via `bookings.wix_booking_id`. Stateless: the watermark lives in
 * `wix_integrations.cursor_updated_date`, so it is safe to run on Vercel cron.
 */
import "server-only";
import { queryBookingsUpdatedSince } from "./client";
import { looseServiceClient } from "./looseDb";

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

// Wix anonymises techs as "Staff Member #N" — provisional display names (owner remaps later).
const STAFF_NAMES: Record<number, string> = { 1: "Tina", 2: "Trish", 3: "Vi", 4: "Anna", 5: "Sally", 6: "Kim", 7: "Jenny" };

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

export type ForwardSyncResult = { created: number; updated: number; skipped: number; cursor: string };

export async function runForwardSync(salonId: string, siteId: string, sinceIso: string): Promise<ForwardSyncResult> {
  // Loosely-typed handle: wix_booking_id column + wix_integrations table aren't in generated types yet.
  const db = looseServiceClient();

  // resolvers (cached per run)
  const { data: svcRows } = await db.from("services").select("id,name,duration_minutes,price_cents").eq("salon_id", salonId);
  const svcByName = new Map<string, { id: string; price: number }>(
    (svcRows ?? []).map((s): [string, { id: string; price: number }] => [normKey(s.name), { id: s.id as string, price: (s.price_cents as number) ?? 0 }]),
  );
  const { data: staffRows } = await db.from("staff").select("id,name").eq("salon_id", salonId);
  const staffByName = new Map<string, string>(
    (staffRows ?? []).map((s): [string, string] => [normKey(s.name), s.id as string]),
  );

  async function resolveService(title: string, durMin: number) {
    const hit = svcByName.get(normKey(title));
    if (hit) return hit;
    const { data } = await db.from("services").insert({ salon_id: salonId, name: titleCase(title || "Service"), price_cents: 0, duration_minutes: Math.max(15, durMin) }).select("id").single();
    const rec = { id: data?.id as string, price: 0 };
    svcByName.set(normKey(title), rec);
    return rec;
  }
  async function resolveStaff(wixName: string): Promise<string | null> {
    const n = staffNum(wixName);
    const name = n != null ? STAFF_NAMES[n] ?? `Artist ${n}` : sanitizeName(wixName);
    if (!name) return null;
    const hit = staffByName.get(normKey(name));
    if (hit) return hit;
    const { data } = await db.from("staff").insert({ salon_id: salonId, name, job_role: "nail_tech", status: "active" }).select("id").single();
    const newId = data?.id as string;
    staffByName.set(normKey(name), newId);
    return newId;
  }

  const bookings = await queryBookingsUpdatedSince(siteId, sinceIso);
  const now = Date.now();
  let created = 0, updated = 0, skipped = 0, maxUpdated = sinceIso;

  for (const b of bookings) {
    const start = b.startDate ?? b.bookedEntity?.slot?.startDate;
    if (!start) { skipped++; continue; }
    const end = b.endDate ?? b.bookedEntity?.slot?.endDate ?? new Date(new Date(start).getTime() + 45 * 60000).toISOString();
    const svc = await resolveService(b.bookedEntity?.title ?? "Service", minutesBetween(start, end));
    const staffId = await resolveStaff(b.bookedEntity?.slot?.resource?.name ?? "");
    const ph = canonPhone(b.contactDetails?.phone);
    const note = (b.additionalFields ?? []).find((f) => f.label === "Add Your Message")?.value || null;
    const status = mapStatus(b.status, new Date(start).getTime(), now);
    const clientName = sanitizeName([b.contactDetails?.firstName, b.contactDetails?.lastName].filter(Boolean).join(" ")) || "Guest";

    if (ph) {
      await db.from("client_profiles").upsert(
        { phone: ph, name: clientName === "Guest" ? null : clientName, email: b.contactDetails?.email ?? null, updated_at: new Date().toISOString() },
        { onConflict: "phone" },
      );
    }

    const fields: Record<string, unknown> = {
      salon_id: salonId, client_name: clientName, client_phone: ph, client_email: b.contactDetails?.email ?? null,
      service_id: svc.id, staff_id: staffId, start_time_utc: start, end_time_utc: end, status, source: "appointment",
      price_cents: svc.price, staff_request_note: note, staff_requested_by_client: noteRequestsStaff(note),
      verification_method: "none", // shields synced 'pending' rows from the release-pending cron
      wix_booking_id: b.id,
    };

    const { data: existing } = await db.from("bookings").select("id").eq("wix_booking_id", b.id).maybeSingle();
    if (existing?.id) {
      const { error } = await db.from("bookings").update(fields).eq("id", existing.id);
      if (error && staffId) await db.from("bookings").update({ ...fields, staff_id: null }).eq("id", existing.id);
      updated++;
    } else {
      let { error } = await db.from("bookings").insert({ ...fields, no_show_risk_score: 8, created_at: new Date().toISOString() });
      if (error && staffId) ({ error } = await db.from("bookings").insert({ ...fields, staff_id: null, no_show_risk_score: 8, created_at: new Date().toISOString() }));
      if (error) skipped++; else created++;
    }
    if (b.updatedDate && b.updatedDate > maxUpdated) maxUpdated = b.updatedDate;
  }

  const newCursor = new Date(new Date(maxUpdated).getTime() + 1).toISOString();
  await db.from("wix_integrations").update({ cursor_updated_date: newCursor, last_run_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("salon_id", salonId);
  return { created, updated, skipped, cursor: newCursor };
}
