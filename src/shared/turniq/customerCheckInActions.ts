"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import { isFrontDeskRole } from "@/shared/lib/salonMemberRole";
import {
  issueTurnIqCustomerCheckInCapability,
  revokeTurnIqCustomerCheckInCapability,
} from "@/shared/turniq/customerCheckInServer";
import { loadTurnIqRolloutStage } from "@/shared/turniq/serverDal";
import { turnIqStageAllowsOnlineMutation } from "@/shared/turniq/rolloutStage";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TurnIqCheckInLinkError =
  | "unauthorized"
  | "forbidden"
  | "feature_disabled"
  | "rollout_stage_blocked"
  | "preview_only"
  | "invalid_request"
  | "not_found"
  | "server_error";

export type TurnIqIssueCheckInLinkInput =
  | { kind: "booked_qr"; bookingId: string }
  | { kind: "walkin_kiosk" };

export type TurnIqIssueCheckInLinkResult =
  | {
      ok: true;
      capabilityId: string;
      checkInPath: string;
      expiresAt: string;
      scope: "one_booking" | "walkin_kiosk";
    }
  | { ok: false; error: TurnIqCheckInLinkError };

export type TurnIqRevokeCheckInLinkResult =
  | { ok: true; capabilityId: string; revokedAt: string; replayed: boolean }
  | { ok: false; error: TurnIqCheckInLinkError };

function isPreviewRuntime(): boolean {
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.VERCEL_ENV === "preview") return true;
  return process.env.NAILIQ_TURNIQ_CHECKIN_LOCAL === "1"
    && process.env.NODE_ENV !== "production";
}

function cleanIssueError(code: string): TurnIqCheckInLinkError {
  if (code === "forbidden") return "forbidden";
  if (code === "feature_disabled") return "feature_disabled";
  if (
    code === "service_not_found"
    || code === "booking_not_found"
    || code === "not_found"
  ) return "not_found";
  if (code.startsWith("invalid_")) return "invalid_request";
  return "server_error";
}

async function authorizedContext(slug: string) {
  const cleanSlug = String(slug ?? "").trim().toLowerCase();
  if (!cleanSlug || cleanSlug.length > 80) {
    return { ok: false as const, error: "invalid_request" as const };
  }
  const ctx = await getDashboardWriteClient(cleanSlug);
  if (!ctx || ctx.kind !== "member" || !ctx.userId) {
    return { ok: false as const, error: "unauthorized" as const };
  }
  if (!isFrontDeskRole(ctx.role)) {
    return { ok: false as const, error: "forbidden" as const };
  }
  if (!isPreviewRuntime()) {
    return { ok: false as const, error: "preview_only" as const };
  }
  if (!(await isReleaseFeatureVisible(ctx.salon, "turniq_trust_engine"))) {
    return { ok: false as const, error: "feature_disabled" as const };
  }
  const rolloutStage = await loadTurnIqRolloutStage(ctx.salon.id);
  if (!turnIqStageAllowsOnlineMutation(rolloutStage)) {
    return { ok: false as const, error: "rollout_stage_blocked" as const };
  }
  return { ok: true as const, ctx, cleanSlug, actorUserId: ctx.userId };
}

/** Creates a narrow, short-lived customer link. The raw bearer exists only in
 * the URL fragment, so it is not sent in HTTP referrers or server request logs. */
export async function issueTurnIqCustomerCheckInLink(
  slug: string,
  input: TurnIqIssueCheckInLinkInput,
): Promise<TurnIqIssueCheckInLinkResult> {
  const auth = await authorizedContext(slug);
  if (!auth.ok) return auth;
  if (!input || (input.kind !== "booked_qr" && input.kind !== "walkin_kiosk")) {
    return { ok: false, error: "invalid_request" };
  }

  const now = Date.now();
  if (input.kind === "walkin_kiosk") {
    const expiresAt = new Date(now + 8 * 60 * 60 * 1_000).toISOString();
    const result = await issueTurnIqCustomerCheckInCapability({
      salonId: auth.ctx.salon.id,
      bookingId: null,
      serviceId: null,
      channel: "kiosk",
      visitKind: "walkin",
      expiresAt,
      maxUses: 100,
      actorUserId: auth.actorUserId,
    });
    if (!result.ok) return { ok: false, error: cleanIssueError(result.code) };
    return {
      ok: true,
      capabilityId: result.capabilityId,
      checkInPath: `/turniq/check-in?salon=${encodeURIComponent(auth.cleanSlug)}&channel=kiosk&visit=walkin#cap=${encodeURIComponent(result.token)}`,
      expiresAt: result.expiresAt,
      scope: "walkin_kiosk",
    };
  }

  const bookingId = String(input.bookingId ?? "").trim();
  if (!UUID_RE.test(bookingId)) return { ok: false, error: "invalid_request" };
  const { data: booking, error } = await auth.ctx.supabase
    .from("bookings")
    .select("id, service_id, party_size, start_time_utc")
    .eq("id", bookingId)
    .eq("salon_id", auth.ctx.salon.id)
    .is("deleted_at", null)
    .in("status", ["pending", "confirmed"])
    .maybeSingle();
  if (error) return { ok: false, error: "server_error" };
  if (!booking?.id || !UUID_RE.test(String(booking.service_id ?? ""))) {
    return { ok: false, error: "not_found" };
  }
  const partySize = Number(booking.party_size ?? 1);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 12) {
    return { ok: false, error: "invalid_request" };
  }
  const appointmentGrace = Date.parse(String(booking.start_time_utc ?? ""))
    + 2 * 60 * 60 * 1_000;
  const expiresMs = Number.isFinite(appointmentGrace) && appointmentGrace > now + 5 * 60 * 1_000
    ? Math.min(now + 24 * 60 * 60 * 1_000, appointmentGrace)
    : now + 10 * 60 * 1_000;
  const result = await issueTurnIqCustomerCheckInCapability({
    salonId: auth.ctx.salon.id,
    bookingId: String(booking.id),
    serviceId: String(booking.service_id),
    channel: "qr",
    visitKind: "booked",
    expiresAt: new Date(expiresMs).toISOString(),
    maxUses: 1,
    actorUserId: auth.actorUserId,
  });
  if (!result.ok) return { ok: false, error: cleanIssueError(result.code) };
  const query = new URLSearchParams({
    salon: auth.cleanSlug,
    channel: "qr",
    visit: "booked",
    service: String(booking.service_id),
    party: String(partySize),
  });
  return {
    ok: true,
    capabilityId: result.capabilityId,
    checkInPath: `/turniq/check-in?${query.toString()}#cap=${encodeURIComponent(result.token)}`,
    expiresAt: result.expiresAt,
    scope: "one_booking",
  };
}

export async function revokeTurnIqCustomerCheckInLink(
  slug: string,
  capabilityIdInput: string,
): Promise<TurnIqRevokeCheckInLinkResult> {
  const auth = await authorizedContext(slug);
  if (!auth.ok) return auth;
  const capabilityId = String(capabilityIdInput ?? "").trim();
  if (!UUID_RE.test(capabilityId)) {
    return { ok: false, error: "invalid_request" };
  }
  const result = await revokeTurnIqCustomerCheckInCapability({
    salonId: auth.ctx.salon.id,
    capabilityId,
    actorUserId: auth.actorUserId,
  });
  if (!result.ok) return { ok: false, error: cleanIssueError(result.code) };
  return {
    ok: true,
    capabilityId: result.capabilityId,
    revokedAt: result.revokedAt,
    replayed: result.replayed,
  };
}
