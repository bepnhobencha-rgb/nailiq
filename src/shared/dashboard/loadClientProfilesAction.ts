"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isOwnerOrAdmin, isFrontDeskRole } from "@/shared/lib/salonMemberRole";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClientProfileRow = {
  /** `client_profile_id` from RPC; may be null for imported-only contacts.
   *  Falls back to phone for stable React keys. */
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  isVip: boolean;
  notes: string | null;
  /** Total completed visit count for this salon (from RPC). */
  visitCount: number;
  /** ISO timestamp of the most recent visit; null for import-only clients. */
  lastVisitAt: string | null;
  /** Sum of price_cents + addon_price_cents on completed bookings. */
  totalSpentCents: number;
};

export type LoadClientProfilesResult =
  | {
      ok: true;
      clients: ClientProfileRow[];
      total: number;
      page: number;
      pageSize: number;
    }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// loadClientProfiles — server-side search + pagination via RPC
// ---------------------------------------------------------------------------

/**
 * Desk-role viewer for the salon's full client directory.
 *
 * Delegates to the `search_salon_clients` RPC (security definer, service-role
 * only) which returns a single page of de-duped clients ordered by name, with
 * a `total_count` column for pagination. Import-only contacts (from Square /
 * membership imports) show visit_count=0 / null last_visit and are included.
 *
 * Auth: owner / senior / admin / receptionist may view. nail_tech is denied
 * (surface exposes phones/emails and aggregate spend).
 */
export async function loadClientProfiles(
  slug: string,
  opts?: { search?: string; page?: number; pageSize?: number },
): Promise<LoadClientProfilesResult> {
  // Auth gate: verify the viewer is a desk role.
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isFrontDeskRole(ctx.role)) {
    return { ok: false, error: "forbidden" };
  }

  // Clamp / default pagination params.
  const rawPage = opts?.page ?? 1;
  const rawPageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Math.floor(rawPage));
  const pageSize = Math.min(100, Math.max(1, Math.floor(rawPageSize)));
  const offset = (page - 1) * pageSize;
  const search = (opts?.search ?? "").trim();

  const supabase = createServiceRoleClient();

  const { data, error } = await supabase.rpc("search_salon_clients", {
    p_salon_id: ctx.salon.id,
    p_search: search,
    p_limit: pageSize,
    p_offset: offset,
  });

  if (error) {
    console.error("[loadClientProfiles] search_salon_clients RPC error", error);
    return { ok: false, error: "server_error" };
  }

  // No rows → empty page.
  const rows = (data ?? []) as Array<{
    client_profile_id: string | null;
    phone: string;
    name: string | null;
    email: string | null;
    is_vip: boolean | null;
    notes: string | null;
    visit_count: number | null;
    last_visit: string | null;
    total_spent_cents: number | null;
    total_count: number | null;
  }>;

  const total = rows.length > 0 ? Number(rows[0]!.total_count ?? 0) : 0;

  const clients: ClientProfileRow[] = rows.map((r) => ({
    // Use profile id when available; fall back to phone for import-only rows.
    id: r.client_profile_id ?? r.phone,
    name: r.name ?? null,
    phone: r.phone,
    email: r.email ?? null,
    isVip: Boolean(r.is_vip),
    notes: r.notes ?? null,
    visitCount: Number(r.visit_count ?? 0),
    lastVisitAt: r.last_visit ?? null,
    totalSpentCents: Number(r.total_spent_cents ?? 0),
  }));

  return { ok: true, clients, total, page, pageSize };
}

// ---------------------------------------------------------------------------
// updateClientProfile — owner-only metadata write (unchanged)
// ---------------------------------------------------------------------------

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
  const resolved = await getDashboardWriteClient(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (!isFrontDeskRole(resolved.role)) return { ok: false, error: "forbidden" };

  const phone = String(input.phone ?? "").trim();
  if (!phone) return { ok: false, error: "not_found" };

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (typeof input.isVip === "boolean") patch.is_vip = input.isVip;
  if (input.notes !== undefined) {
    patch.notes =
      input.notes === null ? null : String(input.notes).slice(0, 2000);
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
