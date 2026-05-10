"use server";

import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type ClientProfileRow = {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  isVip: boolean;
  notes: string | null;
  /** Visit count for THIS salon (derived from bookings, not the cross-salon
   *  `client_profiles.visit_count` column which is a global counter). */
  visitCount: number;
  /** Most recent booking start_time_utc for this salon, ISO. `null` when
   *  the client has no completed/confirmed bookings here. */
  lastVisitAt: string | null;
  /** Sum of price_cents + addon_price_cents on completed bookings for
   *  this salon. */
  totalSpentCents: number;
};

export type LoadClientProfilesResult =
  | { ok: true; rows: ClientProfileRow[] }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

const PAGE_SIZE = 50;

/**
 * Owner+senior viewer for client profiles. Per `PERMISSION_MATRIX §3`,
 * client metadata is operational data the desk needs (`Yes` for both
 * owner and senior); nail_tech is denied here because the surface
 * exposes phones/emails and aggregate spend.
 *
 * Read path: distinct phones from `bookings` for this salon → join
 * cross-salon `client_profiles` (phone-keyed) → aggregate per-salon
 * visit count + last-visit + total spent from the same bookings rows.
 * No new salon-scoped table required.
 *
 * Returns the most recent `PAGE_SIZE` clients sorted by lastVisitAt
 * (descending). Search filtering is performed client-side per the
 * spec — keeps the action simple; full-text search across phone/name
 * is a follow-up.
 */
export async function loadClientProfiles(
  slug: string,
): Promise<LoadClientProfilesResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (resolved.role !== "owner" && resolved.role !== "senior") {
    return { ok: false, error: "forbidden" };
  }

  const supabase = createServiceRoleClient();

  // Pull all this salon's bookings that have a phone — we need them to
  // aggregate per-salon visit/spend counts even for clients that haven't
  // backfilled into `client_profiles` yet (the upsert in
  // `submitPublicBooking` only populates on **public** flow successes).
  // Cancelled rows still count as a "visit attempt" for the receptionist
  // operationally; spend filters to `completed`.
  const { data: bookings, error: bookingsErr } = await supabase
    .from("bookings")
    .select(
      "client_phone, client_name, status, start_time_utc, price_cents, addon_price_cents",
    )
    .eq("salon_id", resolved.salon.id)
    .not("client_phone", "is", null);

  if (bookingsErr) {
    console.error("[loadClientProfiles] bookings", bookingsErr);
    return { ok: false, error: "server_error" };
  }

  type AggRow = {
    name: string | null;
    visitCount: number;
    lastVisitMs: number;
    totalSpentCents: number;
  };
  const agg = new Map<string, AggRow>();

  for (const b of bookings ?? []) {
    const phone = String(b.client_phone ?? "").trim();
    if (!phone) continue;
    const cur = agg.get(phone) ?? {
      name: null as string | null,
      visitCount: 0,
      lastVisitMs: 0,
      totalSpentCents: 0,
    };
    cur.visitCount += 1;
    if (cur.name === null && typeof b.client_name === "string") {
      cur.name = b.client_name.trim() || null;
    }
    const startMs = Date.parse(String(b.start_time_utc ?? ""));
    if (Number.isFinite(startMs) && startMs > cur.lastVisitMs) {
      cur.lastVisitMs = startMs;
    }
    if (b.status === "completed") {
      const main =
        b.price_cents != null && Number.isFinite(Number(b.price_cents))
          ? Number(b.price_cents)
          : 0;
      const addon =
        b.addon_price_cents != null &&
        Number.isFinite(Number(b.addon_price_cents))
          ? Number(b.addon_price_cents)
          : 0;
      cur.totalSpentCents += main + addon;
    }
    agg.set(phone, cur);
  }

  if (agg.size === 0) return { ok: true, rows: [] };

  const phones = Array.from(agg.keys());
  // `email`, `notes`, `is_vip` are not yet in the auto-generated DB
  // types (added by the 20260509210000 migration); cast the select so
  // the projection still typechecks. Becomes a typed call on next type
  // regeneration.
  type ProfilesQuery = {
    is: (col: string, val: null) => ProfilesQuery;
    in: (
      col: string,
      vals: string[],
    ) => Promise<{
      data:
        | Array<{
            id: string;
            phone: string;
            name: string | null;
            email: string | null;
            notes: string | null;
            is_vip: boolean | null;
          }>
        | null;
      error: { message: string } | null;
    }>;
  };
  const profilesBuilder = supabase.from("client_profiles") as unknown as {
    select: (cols: string) => ProfilesQuery;
  };
  const { data: profiles, error: profilesErr } = await profilesBuilder
    .select("id, phone, name, email, notes, is_vip")
    .is("deleted_at", null)
    .in("phone", phones);

  if (profilesErr) {
    console.error("[loadClientProfiles] client_profiles", profilesErr);
    return { ok: false, error: "server_error" };
  }

  type ProfileRow = NonNullable<typeof profiles>[number];
  const profileByPhone = new Map<string, ProfileRow>();
  for (const p of profiles ?? []) {
    profileByPhone.set(String(p.phone), p);
  }

  const rows: ClientProfileRow[] = phones.map((phone) => {
    const a = agg.get(phone)!;
    const p = profileByPhone.get(phone);
    return {
      // Stable id: profile row id when known, else the phone (read-only
      // surface anyway; the panel uses this for React keys).
      id: p?.id ?? phone,
      name: p?.name ?? a.name,
      phone,
      email: p?.email ?? null,
      isVip: Boolean(p?.is_vip),
      notes: p?.notes ?? null,
      visitCount: a.visitCount,
      lastVisitAt:
        a.lastVisitMs > 0 ? new Date(a.lastVisitMs).toISOString() : null,
      totalSpentCents: a.totalSpentCents,
    };
  });

  rows.sort((a, b) => {
    const am = a.lastVisitAt ? Date.parse(a.lastVisitAt) : 0;
    const bm = b.lastVisitAt ? Date.parse(b.lastVisitAt) : 0;
    return bm - am;
  });

  return { ok: true, rows: rows.slice(0, PAGE_SIZE) };
}

export type UpdateClientProfileResult =
  | { ok: true }
  | {
      ok: false;
      error: "unauthorized" | "forbidden" | "not_found" | "server_error";
    };

/**
 * Owner-only update of cross-salon client metadata (notes / VIP).
 * Per the migration comment: notes + is_vip are GLOBAL today —
 * different salons see the same flag. A per-salon split needs a
 * `client_salon_metadata` table; out of scope.
 */
export async function updateClientProfile(
  slug: string,
  input: { phone: string; isVip?: boolean; notes?: string | null },
): Promise<UpdateClientProfileResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (resolved.role !== "owner") return { ok: false, error: "forbidden" };

  const phone = String(input.phone ?? "").trim();
  if (!phone) return { ok: false, error: "not_found" };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof input.isVip === "boolean") patch.is_vip = input.isVip;
  if (input.notes !== undefined) {
    patch.notes = input.notes === null ? null : String(input.notes).slice(0, 2000);
  }

  const supabase = createServiceRoleClient();
  // Don't update soft-deleted profiles — restore them first if needed.
  const { data, error } = await supabase
    .from("client_profiles")
    .update(patch as never)
    .eq("phone", phone)
    .is("deleted_at" as never, null)
    .select("phone")
    .maybeSingle();

  if (error) {
    console.error("[updateClientProfile]", error);
    return { ok: false, error: "server_error" };
  }
  if (!data) {
    // No existing profile row to update. The public booking flow upserts
    // on first booking, so this shouldn't happen in normal use; treat as
    // not_found rather than silently succeeding.
    return { ok: false, error: "not_found" };
  }
  return { ok: true };
}
