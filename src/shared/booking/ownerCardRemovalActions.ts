"use server";
import { revalidatePath } from "next/cache";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { durableRateLimitKey, isOverRateLimit } from "@/shared/lib/inAppRateLimit";
import { reconcileOwnerBookingCardRemoval } from "./reconcileBookingCardRemoval";

export type RemovalException = { operationId: string; bookingId: string; clientLabel: string;
  startTime: string; service: string; lastAttemptAt: string; reason: string | null; canReconcile: boolean };
export type RemovalExceptionsResult = { ok: boolean; items: RemovalException[]; hasMore?: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeReasons = new Set(["context", "authority", "configuration", "provider_read", "database_completion", "dispatch_preparation", "provider_preflight", "provider_mutation", "receipt_validation", "provider_unknown"]);

export async function loadOwnerCardRemovalExceptions(slug: string): Promise<RemovalExceptionsResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx?.userId || !isOwnerOrAdmin(ctx.role)) return { ok: false, items: [] };
  const db = createServiceRoleClient();
  const { data, error } = await db.from("booking_card_management_operations" as never)
    .select("id,booking_id,status,updated_at,dispatch:booking_card_removal_dispatch_bindings(prepared_at),recovery:booking_card_removal_recovery_receipts(operation_id)").is("recovery", null).eq("salon_id", ctx.salon.id).eq("operation", "remove_card")
    .in("status", ["unknown", "sending", "failed"]).order("created_at", { ascending: false }).limit(101);
  if (error) return { ok: false, items: [] };
  const ops = (data ?? []) as { id: string; booking_id: string; status: string; updated_at: string; dispatch?: { prepared_at: string } | null }[];
  if (!ops.length) return { ok: true, items: [] };
  const batch = ops.slice(0, 100);
  const [bookings, events, delivery] = await Promise.all([
    db.from("bookings" as never).select("id,client_name,start_time_utc,services!bookings_service_id_fkey(name)")
      .eq("salon_id", ctx.salon.id).in("id", batch.map(o => o.booking_id)).is("deleted_at", null),
    db.from("booking_card_removal_recovery_events" as never).select("operation_id,stage,created_at")
      .eq("salon_id", ctx.salon.id).in("operation_id", batch.map(o => o.id))
      .order("created_at", { ascending: false }).limit(1000),
    db.from("booking_card_removal_delivery_events" as never).select("operation_id,stage,created_at")
      .eq("salon_id", ctx.salon.id).in("operation_id", batch.map(o => o.id))
      .order("created_at", { ascending: false }).limit(1000),
  ]);
  if (bookings.error || events.error || delivery.error) return { ok: false, items: [] };
  const booked = (bookings.data ?? []) as { id: string; client_name: string | null; start_time_utc: string; services: { name: string } | null }[];
  const history = (events.data ?? []) as { operation_id: string; stage: string; created_at: string }[];
  const initial = (delivery.data ?? []) as { operation_id: string; stage: string; created_at: string }[];
  return { ok: true, hasMore: ops.length > 100, items: batch.flatMap(op => {
    const booking = booked.find(b => b.id === op.booking_id);
    if (!booking) return [];
    const recovery = history.find(e => e.operation_id === op.id);
    const dispatch = initial.find(e => e.operation_id === op.id);
    // Compare actual instants, not formatted strings. Recovery wins an exact tie.
    const latest = dispatch && (!recovery || Date.parse(dispatch.created_at) > Date.parse(recovery.created_at)) ? dispatch : recovery;
    const initials = (booking.client_name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map(v => Array.from(v)[0]).join(". ");
    return [{ operationId: op.id, bookingId: booking.id, clientLabel: initials ? `${initials}.` : "Guest",
      startTime: booking.start_time_utc, service: booking.services?.name ?? "", lastAttemptAt: latest?.created_at ?? op.updated_at,
      reason: latest && safeReasons.has(latest.stage) ? latest.stage : null, canReconcile: op.status === "unknown" || (op.status === "sending" && !!op.dispatch
        && Date.parse(op.dispatch.prepared_at) <= Date.now() - 120000) }];
  }) };
}

export async function reconcileOwnerCardRemoval(slug: string, operationId: string): Promise<{ ok: boolean; code: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx?.userId || !isOwnerOrAdmin(ctx.role)) return { ok: false, code: "unauthorized" };
  if (!uuid.test(operationId)) return { ok: false, code: "invalid_request" };
  if (await isOverRateLimit(durableRateLimitKey("owner-removal-recovery", ctx.salon.id, operationId), 8, 300, { failureMode: "block" })) {
    return { ok: false, code: "rate_limited" };
  }
  // The database independently checks current membership, tenant, operation,
  // original authority and card state again before provider read and completion.
  const result = await reconcileOwnerBookingCardRemoval({ salonId: ctx.salon.id, actorId: ctx.userId, operationId });
  revalidatePath(`/dashboard/${slug}/no-show-protection`);
  return { ok: result.ok, code: result.code };
}
