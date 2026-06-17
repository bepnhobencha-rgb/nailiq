"use server";

import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type { ActorRole, BookingEventType } from "@/shared/dashboard/auditLog";

export type AuditLogRow = {
  id: string;
  bookingId: string;
  actorRole: ActorRole;
  eventType: BookingEventType;
  payload: Record<string, unknown>;
  createdAt: string;
  /** Hydrated client name from the joined booking row. Null when the
   *  underlying booking has no client_name (queue rows pre-naming, etc.). */
  clientName: string | null;
};

export type LoadAuditLogResult =
  | { ok: true; rows: AuditLogRow[] }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" };

const PAGE_SIZE = 50;

/**
 * Owner-only viewer for `booking_events`. Returns the most recent
 * `PAGE_SIZE` rows for the resolved salon. Uses the service-role client
 * for the read because the audit table's RLS is owner/senior-only and
 * we already gated the action on `role === "owner"` here.
 */
export async function loadAuditLog(slug: string): Promise<LoadAuditLogResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(resolved.role)) return { ok: false, error: "forbidden" };

  const supabase = createServiceRoleClient();
  // `booking_events` is not yet in the auto-generated DB types; cast the
  // builder so the join + select still typechecks. Will become a typed
  // call after the next regeneration.
  const builder = supabase.from("booking_events") as unknown as {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        order: (col: string, opts: { ascending: boolean }) => {
          limit: (n: number) => Promise<{
            data:
              | Array<{
                  id: string;
                  booking_id: string;
                  actor_role: string;
                  event_type: string;
                  payload: unknown;
                  created_at: string;
                  bookings: { client_name: string | null } | null;
                }>
              | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
  const { data, error } = await builder
    .select(
      "id, booking_id, actor_role, event_type, payload, created_at, bookings ( client_name )",
    )
    .eq("salon_id", resolved.salon.id)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  if (error) {
    console.error("[loadAuditLog]", error);
    return { ok: false, error: "server_error" };
  }

  const rows: AuditLogRow[] = (data ?? []).map((r) => ({
    id: String(r.id),
    bookingId: String(r.booking_id),
    actorRole: r.actor_role as ActorRole,
    eventType: r.event_type as BookingEventType,
    payload:
      r.payload && typeof r.payload === "object"
        ? (r.payload as Record<string, unknown>)
        : {},
    createdAt: String(r.created_at),
    clientName: r.bookings?.client_name ?? null,
  }));

  return { ok: true, rows };
}
