"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";

/**
 * Typeahead search for the receptionist booking form — find an EXISTING client
 * of THIS salon by name or phone, so the desk picks the known identity instead
 * of retyping and minting a near-duplicate profile.
 *
 * Salon membership is verified via getDashboardWriteClient before any read; the
 * SECURITY DEFINER RPC inner-joins this salon's bookings so a receptionist never
 * sees another salon's customers, even though client_profiles is global.
 */

export type ClientSearchHit = {
  phone: string;
  name: string | null;
  isVip: boolean;
  /** Per-salon count of non-cancelled bookings. */
  visitCount: number;
  /** Per-salon most recent start_time_utc, ISO. */
  lastVisitAt: string | null;
};

export type ClientSearchResult =
  | { ok: false; error: "unauthorized" | "server_error" }
  | { ok: true; hits: ClientSearchHit[] };

const MIN_QUERY_LEN = 2;

export async function searchClients(
  slug: string,
  query: string,
): Promise<ClientSearchResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const q = (query ?? "").trim();
  // Need at least 2 chars (name) or digits (phone) to avoid dumping the book.
  if (q.replace(/\D/g, "").length < MIN_QUERY_LEN && q.length < MIN_QUERY_LEN) {
    return { ok: true, hits: [] };
  }

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[searchClients] service role", e);
    return { ok: false, error: "server_error" };
  }

  type Row = {
    phone?: string | null;
    name?: string | null;
    is_vip?: boolean | null;
    visit_count?: number | null;
    last_visit_at?: string | null;
  };
  const { data, error } = (await admin.rpc("search_salon_client_typeahead" as never, {
    p_salon_id: ctx.salon.id,
    p_query: q,
    p_limit: 8,
  } as never)) as { data: Row[] | null; error: unknown };

  if (error) {
    console.error("[searchClients] rpc", error);
    return { ok: false, error: "server_error" };
  }

  const hits: ClientSearchHit[] = (data ?? [])
    .filter((r) => typeof r.phone === "string" && r.phone.length > 0)
    .map((r) => ({
      phone: String(r.phone),
      name: r.name?.trim() || null,
      isVip: r.is_vip === true,
      visitCount: Number(r.visit_count ?? 0),
      lastVisitAt: r.last_visit_at?.trim() ? String(r.last_visit_at) : null,
    }));

  return { ok: true, hits };
}
