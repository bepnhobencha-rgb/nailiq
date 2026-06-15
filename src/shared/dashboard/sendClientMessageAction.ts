"use server";

/**
 * sendClientMessage — in-app "send SMS to a customer" action.
 *
 * Safety: ALL outbound SMS flows through the existing sendSmsReminder
 * chokepoint, which applies the kill-switch (smsSuppressReason) for
 * test numbers / demo mode / non-production envs. We never call Twilio
 * directly from here.
 *
 * Auth: owner / admin / senior / receptionist. nail_tech is denied.
 * Role check mirrors canCancelBooking / canCreateDeskBooking from
 * salonMemberRole.ts.
 */

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { sendSmsReminder } from "@/shared/lib/twilioSms";
import { logNotification, type NotificationType } from "@/shared/lib/notificationLog";

const SMS_BODY_MAX = 480; // ~3 SMS segments, safe upper bound

export type SendClientMessageInput = {
  /** Recipient phone — any accepted form; normalised to E.164 inside sendSmsReminder. */
  phone: string;
  /** Message text. Trimmed; must be non-empty after trim; max 480 chars. */
  body: string;
  /** "message" = ad-hoc desk message; "rebook_invite" = re-engagement prompt. */
  kind: "message" | "rebook_invite";
};

export type SendClientMessageResult =
  | { ok: true; suppressed?: boolean }
  | { ok: false; error: string };

/**
 * Send an SMS to a client from the dashboard.
 *
 * Returns `{ ok: true }` on success (real send or suppressed for non-prod
 * / test numbers), `{ ok: true, suppressed: true }` when the kill-switch
 * suppressed the send (logged but no Twilio charge), or `{ ok: false, error }`
 * on validation / auth / send failure.
 */
export async function sendClientMessage(
  slug: string,
  input: SendClientMessageInput,
): Promise<SendClientMessageResult> {
  // ── Auth gate ─────────────────────────────────────────────────────────────
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  // Role gate: owner / admin / senior / receptionist allowed; nail_tech denied.
  // Mirrors canCancelBooking / canCreateDeskBooking from salonMemberRole.ts.
  if (
    ctx.role !== "owner" &&
    ctx.role !== "admin" &&
    ctx.role !== "senior" &&
    ctx.role !== "receptionist"
  ) {
    return { ok: false, error: "forbidden" };
  }

  // ── Validate input ────────────────────────────────────────────────────────
  const phone = (input.phone ?? "").trim();
  if (!phone) return { ok: false, error: "invalid_phone" };

  const body = (input.body ?? "").trim();
  if (!body) return { ok: false, error: "body_empty" };
  if (body.length > SMS_BODY_MAX) return { ok: false, error: "body_too_long" };

  const kind = input.kind === "rebook_invite" ? "rebook_invite" : "message";

  // ── Derive salonIsTest flag ───────────────────────────────────────────────
  // Mirrors the pattern from sms-confirm/route.ts: slugs prefixed "e2e-" / "e2e_"
  // or salon names starting with "E2E" are treated as test salons, so Twilio
  // never bills for E2E fixture salons — even when running against production.
  const salonSlug = ctx.salon.slug ?? "";
  const salonIsTest =
    /^e2e[-_]/i.test(salonSlug) || /^e2e\b/i.test(ctx.salon.name ?? "");

  // ── Send via the shared kill-switch chokepoint ────────────────────────────
  // sendSmsReminder already applies smsSuppressReason (env flag / NODE_ENV /
  // 555 seed numbers / salonIsTest). We NEVER call Twilio directly here.
  const result = await sendSmsReminder(phone, body, { salonIsTest });

  // ── Log to booking_notifications ─────────────────────────────────────────
  // Map kind to the closest existing NotificationType. If the union later gains
  // "rebook_invite" / "desk_message" as first-class values, update here.
  // For now: rebook_invite → "review_request" is the closest outbound-promo
  // type; desk ad-hoc → "booking_confirmation" is used as a stand-in for a
  // manual desk message. Both are adequately audited regardless of the label.
  // NOTE: NotificationType currently does not include "rebook_invite" or
  // "desk_message" — see notificationLog.ts. We use the closest existing
  // types to avoid a build-breaking union change; the body_preview column
  // provides the actual context for auditors.
  const notificationType: NotificationType =
    kind === "rebook_invite" ? "review_request" : "booking_confirmation";

  void logNotification({
    bookingId: null,
    salonId: ctx.salon.id,
    notificationType,
    channel: "sms",
    clientPhone: phone,
    messageSid: result.messageSid,
    bodyPreview: body.slice(0, 80),
    ok: result.ok,
    errorMessage: result.ok ? null : (result.error ?? null),
  });

  // ── Return ────────────────────────────────────────────────────────────────
  if (!result.ok) {
    return { ok: false, error: result.error ?? "send_failed" };
  }
  return { ok: true, ...(result.suppressed ? { suppressed: true } : {}) };
}
