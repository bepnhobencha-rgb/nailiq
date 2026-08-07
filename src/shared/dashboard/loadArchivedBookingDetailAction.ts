"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import { maskPhoneDigits } from "@/shared/lib/maskPhone";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

export type ArchivedBookingStatus = "cancelled" | "no_show";
export type ArchivedBookingRecoveryKind = "cancelled_rebook" | "no_show_walkin";

export type RecoveredBookingSummary = {
  id: string;
  status: string;
  recoveryKind: ArchivedBookingRecoveryKind;
  createdAt: string | null;
};

export type ArchivedBookingDetail = {
  id: string;
  status: ArchivedBookingStatus;
  clientName: string;
  clientPhoneMasked: string | null;
  clientNotes: string | null;
  serviceName: string | null;
  staffName: string | null;
  startTimeUtc: string | null;
  endTimeUtc: string | null;
  createdAt: string | null;
  priceCents: number | null;
  currencyCode: string;
  source: string | null;
  bookingChannel: string | null;
  noShowFeeCents: number | null;
  noShowChargeStatus: string | null;
  recoveredBooking: RecoveredBookingSummary | null;
};

export type LoadArchivedBookingDetailResult =
  | { ok: true; detail: ArchivedBookingDetail }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "feature_disabled"
        | "invalid_booking"
        | "not_found"
        | "server_error";
    };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function joinedName(value: unknown): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const name = String((row as { name?: unknown }).name ?? "").trim();
  return name || null;
}

function nullableString(value: unknown): string | null {
  const text = value == null ? "" : String(value).trim();
  return text || null;
}

function nullableCents(value: unknown): number | null {
  if (value == null || value === "") return null;
  const cents = Number(value);
  return Number.isFinite(cents) && cents >= 0 ? Math.round(cents) : null;
}

/**
 * Owner/admin-only, tenant-scoped read of a terminal booking.
 *
 * This action intentionally performs no mutation. The recovery CTA in the
 * Activity drawer only navigates to the Receptionist Center, where a separate
 * reviewed workflow can decide what recovery means for the terminal state.
 */
export async function loadArchivedBookingDetail(
  slug: string,
  bookingId: string,
): Promise<LoadArchivedBookingDetailResult> {
  const normalizedSlug = slug.trim();
  const normalizedBookingId = bookingId.trim();
  if (!normalizedSlug || !UUID_RE.test(normalizedBookingId)) {
    return { ok: false, error: "invalid_booking" };
  }

  const ctx = await getDashboardWriteClient(normalizedSlug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { data: salonRow, error: salonError } = await ctx.supabase
    .from("salons")
    .select(
      "subscription_plan, plan_override, feature_flags, voice_ai_enabled, currency_code",
    )
    .eq("id", ctx.salon.id)
    .maybeSingle();

  if (salonError || !salonRow) {
    console.error("[loadArchivedBookingDetail] salon feature read", salonError);
    return { ok: false, error: "server_error" };
  }

  if (!(await isReleaseFeatureVisible(salonRow, "archived_booking_recovery"))) {
    return { ok: false, error: "feature_disabled" };
  }

  const { data, error } = await ctx.supabase
    .from("bookings")
    .select(
      "id, status, client_name, client_phone, client_notes, start_time_utc, end_time_utc, created_at, price_cents, source, booking_channel, noshow_fee_cents, noshow_charge_status, services!bookings_service_id_fkey ( name ), staff ( name )",
    )
    .eq("id", normalizedBookingId)
    .eq("salon_id", ctx.salon.id)
    .in("status", ["cancelled", "no_show"])
    .maybeSingle();

  if (error) {
    console.error("[loadArchivedBookingDetail] booking read", error);
    return { ok: false, error: "server_error" };
  }
  if (!data || (data.status !== "cancelled" && data.status !== "no_show")) {
    return { ok: false, error: "not_found" };
  }

  const { data: recoveredRow, error: recoveredError } = await ctx.supabase
    .from("bookings")
    .select("id, status, recovery_kind, created_at" as never)
    .eq("salon_id", ctx.salon.id)
    .eq("recovered_from_booking_id" as never, normalizedBookingId)
    .maybeSingle();

  if (recoveredError) {
    console.error(
      "[loadArchivedBookingDetail] recovery trace read",
      recoveredError,
    );
    return { ok: false, error: "server_error" };
  }

  const recovered = recoveredRow as unknown as Record<string, unknown> | null;
  const recoveryKind = nullableString(recovered?.recovery_kind);
  const recoveredBooking: RecoveredBookingSummary | null =
    recovered &&
    (recoveryKind === "cancelled_rebook" || recoveryKind === "no_show_walkin")
      ? {
          id: String(recovered.id),
          status: nullableString(recovered.status) ?? "unknown",
          recoveryKind,
          createdAt: nullableString(recovered.created_at),
        }
      : null;

  const phone = nullableString(data.client_phone);
  return {
    ok: true,
    detail: {
      id: String(data.id),
      status: data.status,
      clientName: nullableString(data.client_name) ?? "Khách",
      clientPhoneMasked: phone ? maskPhoneDigits(phone) : null,
      clientNotes: nullableString(data.client_notes),
      serviceName: joinedName(data.services),
      staffName: joinedName(data.staff),
      startTimeUtc: nullableString(data.start_time_utc),
      endTimeUtc: nullableString(data.end_time_utc),
      createdAt: nullableString(data.created_at),
      priceCents: nullableCents(data.price_cents),
      currencyCode:
        nullableString(salonRow.currency_code) ??
        nullableString(ctx.salon.currency_code) ??
        "CAD",
      source: nullableString(data.source),
      bookingChannel: nullableString(data.booking_channel),
      noShowFeeCents: nullableCents(data.noshow_fee_cents),
      noShowChargeStatus: nullableString(data.noshow_charge_status),
      recoveredBooking,
    },
  };
}
