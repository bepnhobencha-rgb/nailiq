/**
 * NailIQ → Wix write-back. Call after a receptionist confirms/cancels a booking so the
 * change propagates to Wix. Best-effort and fire-and-forget: never throws, never blocks
 * the receptionist action — a Wix outage must not break the desk.
 *
 * Only acts on bookings that carry a `wix_booking_id` (i.e. originated from Wix) whose salon
 * has an enabled `wix_integrations` row.
 */
import "server-only";
import { createHash } from "node:crypto";
import {
  confirmWixBooking,
  cancelWixBooking,
  declineWixBooking,
  createWixBooking,
  getBooking,
  getBookingByExternalUserId,
  type WixBooking,
} from "./client";
import { looseServiceClient } from "./looseDb";

type WixCreateClaim = {
  success?: boolean;
  code?: string;
  operation_id?: string;
  attempt_token?: string;
  provider_external_user_id?: string;
};

type WixLifecycleAction = "confirm" | "cancel" | "decline";
type WixLifecycleClaim = WixCreateClaim & {
  action?: WixLifecycleAction;
  target_status?: "CONFIRMED" | "CANCELED" | "DECLINED";
  provider_booking_id?: string;
};

const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function asClaim(value: unknown): WixCreateClaim {
  return value && typeof value === "object" ? (value as WixCreateClaim) : {};
}

async function completeWixCreate(input: {
  operationId: string;
  attemptToken: string;
  status: "succeeded" | "failed" | "unknown";
  booking?: WixBooking | null;
  errorCode?: string | null;
}): Promise<boolean> {
  const db = looseServiceClient();
  const providerBookingId = input.booking?.id ?? null;
  const providerRevision = input.booking?.revision ?? null;
  const resultFingerprint = fingerprint({
    status: input.status,
    providerBookingId,
    providerRevision,
    errorCode: input.errorCode ?? null,
  });
  const { data, error } = await db.rpc("complete_wix_create_writeback", {
    p_operation_id: input.operationId,
    p_attempt_token: input.attemptToken,
    p_status: input.status,
    p_provider_booking_id: providerBookingId,
    p_provider_revision: providerRevision,
    p_result_fingerprint: resultFingerprint,
    p_error_code: input.errorCode ?? null,
  });
  if (error) {
    console.error("[wix create] completion RPC", input.operationId, error.message);
    return false;
  }
  const completed = asClaim(data);
  if (completed.success !== true) {
    console.error("[wix create] completion rejected", input.operationId, completed.code);
    return false;
  }
  return true;
}

async function completeWixLifecycle(input: {
  operationId: string;
  attemptToken: string;
  status: "succeeded" | "failed" | "unknown";
  booking?: WixBooking | null;
  errorCode?: string | null;
}): Promise<boolean> {
  const db = looseServiceClient();
  const providerRevision = input.booking?.revision ?? null;
  const resultFingerprint = fingerprint({
    status: input.status,
    providerBookingId: input.booking?.id ?? null,
    providerRevision,
    providerStatus: input.booking?.status ?? null,
    errorCode: input.errorCode ?? null,
  });
  const { data, error } = await db.rpc("complete_wix_lifecycle_writeback", {
    p_operation_id: input.operationId,
    p_attempt_token: input.attemptToken,
    p_status: input.status,
    p_provider_revision: providerRevision,
    p_result_fingerprint: resultFingerprint,
    p_error_code: input.errorCode ?? null,
  });
  if (error) {
    console.error("[wix lifecycle] completion RPC", input.operationId, error.message);
    return false;
  }
  const completed = asClaim(data);
  if (completed.success !== true) {
    console.error("[wix lifecycle] completion rejected", input.operationId, completed.code);
    return false;
  }
  return true;
}

async function resolve(salonId: string, bookingId: string): Promise<{ siteId: string; wixId: string } | null> {
  const db = looseServiceClient();
  const { data: integ } = await db.from("wix_integrations").select("site_id").eq("salon_id", salonId).eq("enabled", true).maybeSingle();
  if (!integ?.site_id) return null;
  const { data: bk } = await db.from("bookings").select("wix_booking_id").eq("id", bookingId).maybeSingle();
  if (!bk?.wix_booking_id) return null;
  return { siteId: integ.site_id as string, wixId: bk.wix_booking_id as string };
}

async function pushWixLifecycle(
  salonId: string,
  bookingId: string,
  action: WixLifecycleAction,
): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data, error } = await db.rpc("claim_wix_lifecycle_writeback", {
      p_salon_id: salonId,
      p_booking_id: bookingId,
      p_action: action,
    });
    if (error) {
      console.error("[wix lifecycle] claim RPC", bookingId, action, error.message);
      return;
    }
    const claim = asClaim(data) as WixLifecycleClaim;
    if (
      claim.code === "operation_succeeded" ||
      claim.code === "operation_in_flight" ||
      claim.code === "reconciliation_not_due"
    ) return;
    if (
      claim.success !== true ||
      !claim.operation_id ||
      !claim.attempt_token ||
      claim.action !== action ||
      !claim.target_status ||
      !["operation_claimed", "reconciliation_claimed"].includes(claim.code ?? "")
    ) {
      console.warn("[wix lifecycle] claim rejected", bookingId, action, claim.code);
      return;
    }

    const r = await resolve(salonId, bookingId);
    if (!r) return;
    let providerBooking: WixBooking | null;
    try {
      providerBooking = await getBooking(r.siteId, r.wixId);
    } catch (e) {
      await completeWixLifecycle({
        operationId: claim.operation_id,
        attemptToken: claim.attempt_token,
        status: "unknown",
        errorCode: `provider_lookup_failed:${(e as Error).message}`.slice(0, 240),
      });
      return;
    }
    if (!providerBooking) {
      await completeWixLifecycle({
        operationId: claim.operation_id,
        attemptToken: claim.attempt_token,
        status: "unknown",
        errorCode: "provider_booking_not_found",
      });
      return;
    }
    const normalizedStatus = providerBooking.status.toUpperCase().replace("CANCELLED", "CANCELED");
    if (normalizedStatus === claim.target_status) {
      await completeWixLifecycle({
        operationId: claim.operation_id,
        attemptToken: claim.attempt_token,
        status: "succeeded",
        booking: providerBooking,
      });
      return;
    }
    if (claim.code === "reconciliation_claimed") {
      await completeWixLifecycle({
        operationId: claim.operation_id,
        attemptToken: claim.attempt_token,
        status: "unknown",
        booking: providerBooking,
        errorCode: `provider_target_not_visible:${normalizedStatus}`,
      });
      return;
    }

    try {
      if (action === "confirm") await confirmWixBooking(r.siteId, r.wixId);
      else if (action === "cancel") await cancelWixBooking(r.siteId, r.wixId);
      else await declineWixBooking(r.siteId, r.wixId);
      providerBooking = await getBooking(r.siteId, r.wixId);
      const finalStatus = providerBooking?.status.toUpperCase().replace("CANCELLED", "CANCELED");
      if (!providerBooking || finalStatus !== claim.target_status) {
        await completeWixLifecycle({
          operationId: claim.operation_id,
          attemptToken: claim.attempt_token,
          status: "unknown",
          booking: providerBooking,
          errorCode: `provider_target_not_visible:${finalStatus ?? "NOT_FOUND"}`,
        });
        return;
      }
      await completeWixLifecycle({
        operationId: claim.operation_id,
        attemptToken: claim.attempt_token,
        status: "succeeded",
        booking: providerBooking,
      });
    } catch (e) {
      await completeWixLifecycle({
        operationId: claim.operation_id,
        attemptToken: claim.attempt_token,
        status: "unknown",
        booking: providerBooking,
        errorCode: `provider_${action}_outcome_unknown:${(e as Error).message}`.slice(0, 240),
      });
    }
  } catch (e) {
    console.error("[wix lifecycle]", action, bookingId, (e as Error).message);
  }
}

export async function pushWixCancel(salonId: string, bookingId: string): Promise<void> {
  return pushWixLifecycle(salonId, bookingId, "cancel");
}

export async function pushWixConfirm(salonId: string, bookingId: string): Promise<void> {
  return pushWixLifecycle(salonId, bookingId, "confirm");
}

export async function pushWixDecline(salonId: string, bookingId: string): Promise<void> {
  return pushWixLifecycle(salonId, bookingId, "decline");
}

/**
 * Push a newly-created NailIQ booking to Wix so it appears on the Wix calendar.
 * Best-effort: any failure is logged but does NOT throw (booking already exists in NailIQ).
 * On success, stores the returned Wix booking ID on the NailIQ booking row so that the
 * forward sync never creates a duplicate on the next poll.
 * Uses skipAvailabilityValidation + skipBusinessConfirmation to bypass Wix schedule checks.
 * notifyParticipants: false — NailIQ already sends SMS/email.
 */
export async function pushWixCreate(salonId: string, bookingId: string): Promise<void> {
  try {
    const db = looseServiceClient();

    // 1. Check salon has an enabled wix_integrations row.
    const { data: rawInteg } = await db
      .from("wix_integrations")
      .select("site_id, wix_location_id, wix_default_resource_id")
      .eq("salon_id", salonId)
      .eq("enabled", true)
      .maybeSingle();
    const integ = rawInteg as { site_id?: string; wix_location_id?: string | null; wix_default_resource_id?: string | null } | null;
    if (!integ?.site_id) return; // no Wix integration for this salon

    // 2. Fetch the NailIQ booking row.
    const { data: rawBk } = await db
      .from("bookings")
      .select("id, service_id, staff_id, start_time_utc, end_time_utc, client_name, client_phone, client_email, wix_booking_id")
      .eq("id", bookingId)
      .maybeSingle();
    const bk = rawBk as {
      id: string;
      service_id: string | null;
      staff_id: string | null;
      start_time_utc: string | null;
      end_time_utc: string | null;
      client_name: string | null;
      client_phone: string | null;
      client_email: string | null;
      wix_booking_id: string | null;
    } | null;
    if (!bk) return;
    // Do not return solely because the booking is linked. A forward-sync may
    // have found the provider row after a lost create response while the
    // durable operation still says unknown; the claim/read path below closes
    // that receipt without redispatch. A linked booking with no operation is
    // returned as already_linked by the RPC.
    if (!bk.start_time_utc || !bk.end_time_utc) return;

    // 3. Fetch salon timezone.
    const { data: rawSalon } = await db
      .from("salons")
      .select("timezone")
      .eq("id", salonId)
      .maybeSingle();
    const timezone = (rawSalon as { timezone?: string | null } | null)?.timezone ?? "America/Vancouver";

    // 4. Fetch service Wix IDs (added by migration 20260602100000 — not yet in generated types).
    const { data: rawSvc } = await db
      .from("services")
      .select("name, wix_service_id, wix_schedule_id")
      .eq("id", bk.service_id ?? "")
      .maybeSingle();
    const svc = rawSvc as { name?: string | null; wix_service_id?: string | null; wix_schedule_id?: string | null } | null;
    if (!svc?.wix_service_id || !svc?.wix_schedule_id) {
      // Service has no Wix counterpart — cannot create on Wix.
      console.warn("[wix create] no wix_service_id/wix_schedule_id for booking", bookingId, "service", bk.service_id);
      return;
    }

    // 5. Fetch staff Wix resource ID (optional — skip if no staff assigned or not mapped yet).
    let wixResourceId: string | null = null;
    if (bk.staff_id) {
      const { data: rawStf } = await db
        .from("staff")
        .select("wix_resource_id")
        .eq("id", bk.staff_id)
        .maybeSingle();
      wixResourceId = (rawStf as { wix_resource_id?: string | null } | null)?.wix_resource_id ?? null;
    }

    // 6. Build Wix Create Booking payload.
    // Normalize timestamps to strict ISO-8601 (`...Z`). PostgREST returns `+00:00`-suffixed
    // strings which Wix's slot validator can reject.
    const toIso = (s: string) => new Date(s).toISOString();
    const slot: Record<string, unknown> = {
      serviceId:  svc.wix_service_id,
      scheduleId: svc.wix_schedule_id,
      startDate:  toIso(bk.start_time_utc),
      endDate:    toIso(bk.end_time_utc),
      timezone,
    };
    // A Wix slot without a sessionId REQUIRES both resource.id and location.locationType.
    // Fall back to the salon's configured default resource when the assigned tech isn't mapped
    // to Wix (e.g. a NailIQ-only staff). Without any resource we cannot create — skip, don't guess.
    const resourceId = wixResourceId ?? integ.wix_default_resource_id ?? null;
    if (!resourceId) {
      console.warn("[wix create] no Wix resource for booking", bookingId, "staff", bk.staff_id, "— set wix_integrations.wix_default_resource_id");
      return;
    }
    slot.resource = { id: resourceId };
    slot.location = { locationType: "OWNER_BUSINESS" };

    // Split client_name into first/last (Wix requires separate fields).
    const nameParts  = (bk.client_name ?? "").trim().split(/\s+/);
    const firstName  = nameParts[0] ?? "Guest";
    const lastName   = nameParts.slice(1).join(" ") || undefined;

    const createBody: Record<string, unknown> = {
      booking: {
        // Stable provider-side correlation key. Wix Reader V2 supports exact
        // filtering by externalUserId, which is how an ambiguous create is
        // reconciled without POSTing a second appointment.
        externalUserId: bookingId,
        bookedEntity: {
          slot,
          ...(svc.name ? { title: svc.name } : {}),
          tags: ["INDIVIDUAL"],
        },
        contactDetails: {
          firstName,
          ...(lastName             ? { lastName }             : {}),
          ...(bk.client_phone      ? { phone: bk.client_phone }  : {}),
          ...(bk.client_email      ? { email: bk.client_email }  : {}),
        },
        // Wix REQUIRES participantsChoices or totalParticipants — omitting it 400s the request.
        totalParticipants: 1,
        selectedPaymentOption: "OFFLINE",
      },
      // NailIQ already sends its own SMS/email; suppress Wix's. (Top-level notifyParticipants is
      // not a real field — the notification toggle lives under participantNotification.)
      participantNotification: { notifyParticipants: false },
      flowControlSettings: {
        skipAvailabilityValidation:          true,
        skipBusinessConfirmation:            true,
        skipSelectedPaymentOptionValidation: true,
      },
    };

    // 7. Acquire the durable single-winner claim. A previous timed-out send is
    // reconciliation-only: it may query externalUserId, but it may not create.
    const { data: claimData, error: claimError } = await db.rpc(
      "claim_wix_create_writeback",
      { p_salon_id: salonId, p_booking_id: bookingId },
    );
    if (claimError) {
      console.error("[wix create] claim RPC", bookingId, claimError.message);
      return;
    }
    const claim = asClaim(claimData);
    if (
      claim.code === "operation_succeeded" ||
      claim.code === "already_linked" ||
      claim.code === "operation_in_flight" ||
      claim.code === "reconciliation_not_due"
    ) return;
    if (
      claim.success !== true ||
      !claim.operation_id ||
      !claim.attempt_token ||
      claim.provider_external_user_id !== bookingId ||
      !["operation_claimed", "reconciliation_claimed"].includes(claim.code ?? "")
    ) {
      console.warn("[wix create] claim rejected", bookingId, claim.code);
      return;
    }

    let providerBooking: WixBooking | null = null;
    try {
      providerBooking = await getBookingByExternalUserId(integ.site_id, bookingId);
    } catch (e) {
      await completeWixCreate({
        operationId: claim.operation_id,
        attemptToken: claim.attempt_token,
        status: "unknown",
        errorCode: `provider_lookup_failed:${(e as Error).message}`.slice(0, 240),
      });
      return;
    }

    if (!providerBooking && claim.code === "reconciliation_claimed") {
      // Provider reads may be eventually consistent. Keep the outcome unknown
      // and try the read again later; never convert a missing read into a POST.
      await completeWixCreate({
        operationId: claim.operation_id,
        attemptToken: claim.attempt_token,
        status: "unknown",
        errorCode: "provider_booking_not_visible",
      });
      return;
    }

    if (!providerBooking) {
      try {
        const wixBookingId = await createWixBooking(integ.site_id, createBody);
        providerBooking = {
          id: wixBookingId,
          externalUserId: bookingId,
          revision: "",
          status: "CREATED",
        };
      } catch (e) {
        // A transport exception can happen after Wix commits. Persist unknown;
        // the next run must query externalUserId and must not redispatch.
        await completeWixCreate({
          operationId: claim.operation_id,
          attemptToken: claim.attempt_token,
          status: "unknown",
          errorCode: `provider_create_outcome_unknown:${(e as Error).message}`.slice(0, 240),
        });
        return;
      }
    }

    const bound = await completeWixCreate({
      operationId: claim.operation_id,
      attemptToken: claim.attempt_token,
      status: "succeeded",
      booking: providerBooking,
    });
    if (!bound) return;

    // 8. Confirm through the durable lifecycle contract. Create Booking yields
    // CREATED, which is not visible on the main calendar. The lifecycle worker
    // records response loss and reconciles provider truth before any retry.
    await pushWixConfirm(salonId, bookingId);
    console.log(`[wix create] ✓ bound wix booking ${providerBooking.id} for nailiq ${bookingId}`);
  } catch (e) {
    // Best-effort — never throw (booking already exists in NailIQ).
    console.error("[wix create] error", bookingId, (e as Error).message);
  }
}

/**
 * Reconciliation safety-net: close durable ambiguous operations first, then
 * push recent NailIQ-origin bookings that should be on Wix but are not linked.
 *
 * The immediate per-creation push (public booking page, walk-in queue, …) is best-effort and
 * fire-and-forget — it can be missed (client navigates away, a creation path that isn't wired,
 * a transient Wix error). Running this every cron cycle makes NailIQ→Wix eventually-consistent
 * regardless of *how* the booking was created. Idempotent: pushWixCreate stamps wix_booking_id,
 * so each booking is pushed at most once, and pushWixCreate's own guards skip anything unmappable.
 *
 * Scope is deliberately narrow to avoid retrying forever / pushing stale rows:
 *   - wix_booking_id IS NULL  (not already on Wix / not Wix-originated)
 *   - status in (confirmed, pending)  (active — never push cancelled/no_show/completed)
 *   - start_time_utc > now()  (Wix rejects past slots)
 *   - created_at within the last 24h  (a fresh miss; older ones need manual attention)
 */
export async function pushUnsyncedBookings(salonId: string, limit = 20): Promise<number> {
  try {
    const db = looseServiceClient();
    const nowIso = new Date().toISOString();
    const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: dueData } = await db
      .from("wix_create_writeback_operations")
      .select("booking_id")
      .eq("salon_id", salonId)
      .in("status", ["sending", "reconciling", "unknown"])
      .order("created_at", { ascending: true })
      .limit(limit);
    const dueRows = (dueData ?? []) as { booking_id: string }[];
    const attempted = new Set<string>();
    for (const row of dueRows) {
      attempted.add(row.booking_id);
      await pushWixCreate(salonId, row.booking_id);
    }

    const { data } = await db
      .from("bookings")
      .select("id")
      .eq("salon_id", salonId)
      .is("wix_booking_id", null)
      .in("status", ["confirmed", "pending"])
      .gt("start_time_utc", nowIso)
      .gt("created_at", dayAgoIso)
      .order("start_time_utc", { ascending: true })
      .limit(limit);
    const rows = (data ?? []) as { id: string }[];
    for (const r of rows) {
      if (attempted.has(r.id)) continue;
      attempted.add(r.id);
      // pushWixCreate is self-guarding + idempotent (skips unmapped service / already-linked).
      await pushWixCreate(salonId, r.id);
    }
    return attempted.size;
  } catch (e) {
    console.error("[wix reconcile]", salonId, (e as Error).message);
    return 0;
  }
}

/** Close outstanding confirm/cancel/decline receipts without blind retries. */
export async function reconcileWixLifecycleWritebacks(
  salonId: string,
  limit = 20,
): Promise<number> {
  try {
    const db = looseServiceClient();
    const { data } = await db
      .from("wix_lifecycle_writeback_operations")
      .select("booking_id, action")
      .eq("salon_id", salonId)
      .in("status", ["sending", "reconciling", "unknown"])
      .order("created_at", { ascending: true })
      .limit(limit);
    const rows = (data ?? []) as Array<{
      booking_id: string;
      action: WixLifecycleAction;
    }>;
    for (const row of rows) {
      await pushWixLifecycle(salonId, row.booking_id, row.action);
    }
    return rows.length;
  } catch (e) {
    console.error("[wix lifecycle reconcile]", salonId, (e as Error).message);
    return 0;
  }
}
