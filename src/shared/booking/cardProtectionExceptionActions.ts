"use server";
import { revalidatePath } from "next/cache";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isCardProtectionStatus, type CardProtectionStatus } from "./cardProtection";
import { reconcileBookingCardSaveOperations } from "./reconcileBookingCardSaveOperations";
import { durableRateLimitKey, isOverRateLimit } from "@/shared/lib/inAppRateLimit";

export type CardProtectionException = {
  bookingId: string; clientLabel: string; startTime: string; service: string;
  status: CardProtectionStatus; failureStage: string | null; failureCode: string | null;
  lastAttemptAt: string | null; reviewedAt: string | null; hasExistingCard: boolean; canReconcile: boolean;
};
export async function loadCardProtectionExceptions(slug: string): Promise<{ ok: boolean; items: CardProtectionException[]; hasMore?: boolean }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) return { ok: false, items: [] };
  const db = createServiceRoleClient();
  const { data, error } = await db.from("bookings" as never)
    .select("id,client_name,start_time_utc,card_protection_status,card_protection_reviewed_at,noshow_card_id,services!bookings_service_id_fkey(name)")
    .eq("salon_id", ctx.salon.id).is("deleted_at", null).neq("status", "cancelled")
    .in("card_protection_status", ["awaiting_card", "saving", "reconciliation_pending", "retry_required", "manual_review"])
    .order("start_time_utc", { ascending: false }).limit(101);
  if (error || !data) return { ok: false, items: [] };
  const bookings = data as { id: string; client_name: string | null; start_time_utc: string; card_protection_status: unknown; card_protection_reviewed_at: string | null; noshow_card_id: string | null; services: { name: string } | null }[];
  if (!bookings.length) return { ok: true, items: [] };
  const { data: operations, error: opError } = await db.from("booking_card_save_operations" as never)
    .select("booking_id,status,first_failure_stage,first_failure_code,updated_at,reviewed_at")
    .eq("salon_id", ctx.salon.id).eq("mode", "save_card").in("booking_id", bookings.slice(0,100).map((booking) => booking.id))
    .order("created_at", { ascending: false }).order("delivery_sequence", { ascending: false }).limit(1000);
  if (opError) return { ok: false, items: [] };
  const rows = (operations ?? []) as { booking_id: string; status: string; first_failure_stage: string | null; first_failure_code: string | null; updated_at: string; reviewed_at: string | null }[];
  const { data: checks, error: checkError } = await db.from("booking_legacy_card_checks" as never)
    .select("booking_id,stage,code,created_at").eq("salon_id",ctx.salon.id)
    .in("booking_id",bookings.slice(0,100).map(booking => booking.id))
    .order("created_at",{ascending:false}).limit(1000);
  if (checkError) return { ok:false,items:[] };
  const checkRows = (checks ?? []) as {booking_id:string;stage:string;code:string;created_at:string}[];
  return { ok: true, hasMore: bookings.length > 100, items: bookings.slice(0,100).flatMap((booking) => {
    if (!isCardProtectionStatus(booking.card_protection_status)) return [];
    const operation = rows.find((row) => row.booking_id === booking.id);
    const check = checkRows.find(row => row.booking_id === booking.id);
    const latestCheck = check && (!operation || check.created_at > operation.updated_at) ? check : null;
    // Initials only. Never send full contact, customer/card IDs or provider material to the list.
    const initials = (booking.client_name ?? "").trim().split(/\s+/).filter(Boolean).slice(0,2).map((part) => Array.from(part)[0]).join(". ");
    return [{ bookingId: booking.id, clientLabel: initials ? `${initials}.` : "Guest",
      hasExistingCard: !!booking.noshow_card_id, canReconcile: !!operation && ["sending","unknown"].includes(operation.status),
      startTime: booking.start_time_utc, service: booking.services?.name ?? "", status: booking.card_protection_status,
      failureStage: latestCheck?.stage ?? operation?.first_failure_stage ?? null, failureCode: latestCheck?.code ?? operation?.first_failure_code ?? null,
      lastAttemptAt: latestCheck?.created_at ?? operation?.updated_at ?? null, reviewedAt: booking.card_protection_reviewed_at ?? operation?.reviewed_at ?? null }];
  }) };
}

export async function actOnCardProtectionException(slug: string, bookingId: string,
  action: "retry_link" | "reconcile" | "reviewed"): Promise<{ ok: boolean; retryPath?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !ctx.userId || !isOwnerOrAdmin(ctx.role) || !/^[0-9a-f-]{36}$/i.test(bookingId) ||
      !["retry_link", "reconcile", "reviewed"].includes(action)) return { ok: false };
  if (await isOverRateLimit(durableRateLimitKey("card-exception", ctx.salon.id, bookingId), 8, 300, { failureMode: "block" })) return { ok: false };
  const db = createServiceRoleClient();
  // Recheck the tenant on every action. Client-supplied IDs never select a salon.
  const { data: booking, error } = await db.from("bookings" as never).select("id")
    .eq("id", bookingId).eq("salon_id", ctx.salon.id).is("deleted_at", null).maybeSingle();
  if (error || !booking) return { ok: false };
  if (action === "retry_link") {
    // Reuse an existing recovery link while it remains valid. A double click or
    // HTTP replay must not revoke the link already shown to the owner.
    const { data: existing, error: existingError } = await db.from("booking_management_capabilities" as never)
      .select("id").eq("salon_id",ctx.salon.id).eq("booking_id",bookingId).eq("action","card_manage")
      .gt("expires_at",new Date(Date.now()+60_000).toISOString())
      .or("revoked_at.is.null,revoke_reason.eq.card_delivery_settled")
      .order("created_at",{ascending:false}).limit(1).maybeSingle();
    if (existingError) return { ok:false };
    if (existing && typeof (existing as {id?:string}).id === "string") return {ok:true,retryPath:`/booking/save-card?token=${encodeURIComponent((existing as {id:string}).id)}`};
    const { data, error: mintError } = await db.rpc("mint_owner_booking_card_retry" as never, {
      p_salon_id: ctx.salon.id, p_booking_id: bookingId, p_actor_id: ctx.userId,
    } as never);
    const result = data as { ok?: boolean; token_id?: string } | null;
    return !mintError && result?.ok === true && typeof result.token_id === "string"
      ? { ok: true, retryPath: `/booking/save-card?token=${encodeURIComponent(result.token_id)}` } : { ok: false };
  }
  if (action === "reviewed") {
    const { data, error: reviewError } = await db.rpc("mark_booking_card_protection_reviewed" as never,
      { p_booking_id: bookingId, p_salon_id: ctx.salon.id, p_actor_id: ctx.userId } as never);
    revalidatePath(`/dashboard/${slug}/no-show-protection`);
    return { ok: !reviewError && (data as { ok?: boolean } | null)?.ok === true };
  }
  const { data: operation, error: opError } = await db.from("booking_card_save_operations" as never).select("id")
    .eq("salon_id", ctx.salon.id).eq("booking_id", bookingId).eq("mode", "save_card")
    .order("created_at", { ascending: false }).order("delivery_sequence", { ascending: false }).limit(1).maybeSingle();
  const operationId = (operation as { id?: string } | null)?.id;
  if (opError || !operationId) return { ok: false };
  const result = await reconcileBookingCardSaveOperations(1, operationId);
  const ok = result.processed > 0;
  revalidatePath(`/dashboard/${slug}/no-show-protection`);
  return { ok };
}
