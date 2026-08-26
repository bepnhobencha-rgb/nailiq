import { createHash } from "node:crypto";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { formatInSalonTz } from "@/shared/lib/salonTime";
import { displayCustomerName } from "@/shared/lib/customerDisplayName";
import {
  parseOwnerNotificationSettings,
  shouldNotify,
  type OwnerNotificationEvent,
} from "@/shared/dashboard/ownerNotificationSettings";
import { compareBookingStartInstants } from "@/shared/dashboard/bookingStartComparison";
import {
  ownerNotificationActorLabel,
  ownerNotificationChangesLabel,
  ownerRescheduleTimeLabels,
  type OwnerNotificationActor,
  type OwnerNotificationChangeField,
} from "@/shared/dashboard/ownerBookingNotificationCopy";

/**
 * Email owner/admin when a booking is created / rescheduled / cancelled /
 * marked no-show. Opt-in per salon (Settings → "Manager email alerts").
 *
 * Best-effort: every call is fire-and-forget (`void ...`) and never throws into
 * the booking write path. Detail lookup + recipient resolution happen here so
 * each call site only passes the salon id, booking id, and event.
 */

export type OwnerNotifyInput = {
  salonId: string;
  bookingId: string;
  event: OwnerNotificationEvent;
  /** Previous start time (UTC ISO) for reschedule emails. */
  previousStartUtc?: string | null;
  /** Who initiated the change, shown to the owner/admin for clarity. */
  changedBy?: OwnerNotificationActor | null;
  /** Fields changed as part of a real reschedule (time is always included). */
  changedFields?: OwnerNotificationChangeField[] | null;
  /** Party size for group bookings (>1). Renders a "Group · Nhóm · N" badge so
   *  the owner knows the email represents a whole party, not one guest. */
  groupSize?: number | null;
};

const EVENT_LABEL: Record<OwnerNotificationEvent, { en: string; vi: string }> = {
  new: { en: "New booking", vi: "Đặt hẹn mới" },
  reschedule: { en: "Booking rescheduled", vi: "Đổi giờ hẹn" },
  cancel: { en: "Booking cancelled", vi: "Huỷ hẹn" },
  no_show: { en: "No-show", vi: "Khách không đến" },
};

/** Per-event color language so an owner recognizes the event at a glance. */
const EVENT_STYLE: Record<
  OwnerNotificationEvent,
  { accent: string; badgeBg: string; badgeText: string; emoji: string }
> = {
  new: { accent: "#15803d", badgeBg: "#dcfce7", badgeText: "#166534", emoji: "✨" },
  reschedule: { accent: "#b45309", badgeBg: "#fef3c7", badgeText: "#92400e", emoji: "🔄" },
  cancel: { accent: "#b91c1c", badgeBg: "#fee2e2", badgeText: "#991b1b", emoji: "✕" },
  no_show: { accent: "#b91c1c", badgeBg: "#fee2e2", badgeText: "#991b1b", emoji: "⚠️" },
};

/** Granular booking_channel → bilingual label (falls back to coarse `source`). */
const CHANNEL_LABEL: Record<string, string> = {
  online: "Online · Đặt online",
  square: "Square",
  wix: "Wix",
  voice: "Voice AI · Gọi điện",
  walkin: "Walk-in · Khách vãng lai",
  desk: "Front desk · Tại quầy",
  appointment: "Online · Đặt online",
};

const esc = (s: string) =>
  s.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
  );

function recipientLogRef(recipient: string): string {
  return `recipient:${createHash("sha256")
    .update(recipient.trim().toLowerCase())
    .digest("hex")
    .slice(0, 12)}`;
}

function sanitizeProviderError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(
            (error as { message?: unknown } | null)?.message ??
              "provider_error",
          );
  return raw
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}

function normalizeOccurrenceInstant(value: string | null | undefined): string | null {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

export function ownerNotificationOccurrenceKey(
  event: OwnerNotificationEvent,
  booking: {
    createdAt?: string | null;
    updatedAt?: string | null;
    startTimeUtc?: string | null;
  },
): string | null {
  if (event === "new") return normalizeOccurrenceInstant(booking.createdAt);
  if (event === "reschedule") {
    const start = normalizeOccurrenceInstant(booking.startTimeUtc);
    const updated = normalizeOccurrenceInstant(booking.updatedAt);
    // Start alone collides when an appointment moves A -> B -> A. Pairing the
    // authoritative transition timestamp keeps exact retries idempotent while
    // allowing the later transition back to A to notify once.
    return start && updated ? `${start}|${updated}` : null;
  }
  return normalizeOccurrenceInstant(booking.updatedAt);
}

/** Absolute origin for dashboard links in emails (mirrors booking email helper). */
function getEmailOrigin(): string {
  const base =
    (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  const origin = base.length > 0 ? base : "https://nailiq.ca";
  return origin.replace(/\/$/, "");
}

/** cents → localized currency string, or null when there's nothing to show. */
function fmtMoney(
  cents: number | null | undefined,
  currency: string,
): string | null {
  if (cents == null || cents <= 0) return null;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

async function resolveRecipients(
  admin: ReturnType<typeof createServiceRoleClient>,
  salonId: string,
  notifyMembers: boolean,
  customEmails: string[],
): Promise<string[]> {
  const set = new Set<string>();
  for (const e of customEmails) set.add(e.toLowerCase());

  if (notifyMembers) {
    const { data: members } = await admin
      .from("salon_members")
      .select("user_id, role")
      .eq("salon_id", salonId)
      .in("role", ["owner", "admin"]);
    const userIds = Array.from(
      new Set(
        ((members ?? []) as { user_id: string }[])
          .map((m) => m.user_id)
          .filter(Boolean),
      ),
    );
    const emails = await Promise.all(
      userIds.map(async (uid) => {
        const { data, error } = await admin.auth.admin.getUserById(uid);
        return error ? null : (data.user?.email ?? null);
      }),
    );
    for (const e of emails) if (e) set.add(e.toLowerCase());
  }
  return Array.from(set);
}

type NotifyLogRow = {
  salonId: string;
  bookingId?: string | null;
  event: string;
  recipient?: string;
  status: "sent" | "failed" | "skipped";
  resendId?: string | null;
  error?: string | null;
};

type OwnerClaimStatus = "sent" | "failed" | "unknown" | "suppressed";

type OwnerClaimRpcClient = {
  rpc: (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<{
    data: unknown;
    error: { message?: string | null } | null;
  }>;
};

function isBookingEvent(event: string): event is OwnerNotificationEvent {
  return (
    event === "new" ||
    event === "reschedule" ||
    event === "cancel" ||
    event === "no_show"
  );
}

async function claimOwnerRecipient(
  admin: ReturnType<typeof createServiceRoleClient>,
  meta: {
    salonId: string;
    bookingId: string;
    event: OwnerNotificationEvent;
    eventOccurrenceKey: string;
  },
  recipient: string,
): Promise<
  | { claimed: true; claimId: string }
  | { claimed: false; reason: string }
> {
  try {
    const { data, error } = await (admin as unknown as OwnerClaimRpcClient).rpc(
      "claim_owner_booking_notification",
      {
        p_salon_id: meta.salonId,
        p_booking_id: meta.bookingId,
        p_event_type: meta.event,
        p_recipient_identity: recipient,
        p_event_occurrence_key: meta.eventOccurrenceKey,
      },
    );
    if (error) {
      return { claimed: false, reason: "claim_rpc_error" };
    }
    const result = data as {
      success?: unknown;
      code?: unknown;
      claimed?: unknown;
      claim_id?: unknown;
    } | null;
    if (
      result?.success === true &&
      result.claimed === true &&
      typeof result.claim_id === "string" &&
      result.claim_id.length > 0
    ) {
      return { claimed: true, claimId: result.claim_id };
    }
    if (result?.success === true && result.claimed === false) {
      return {
        claimed: false,
        reason:
          typeof result.code === "string"
            ? result.code
            : "duplicate_suppressed",
      };
    }
    return {
      claimed: false,
      reason:
        typeof result?.code === "string" ? result.code : "invalid_claim_response",
    };
  } catch {
    return { claimed: false, reason: "claim_rpc_exception" };
  }
}

async function completeOwnerRecipientClaim(
  admin: ReturnType<typeof createServiceRoleClient>,
  claimId: string,
  status: OwnerClaimStatus,
  providerMessageId: string | null,
  errorMessage: string | null,
): Promise<boolean> {
  try {
    const { data, error } = await (admin as unknown as OwnerClaimRpcClient).rpc(
      "complete_owner_booking_notification",
      {
        p_claim_id: claimId,
        p_status: status,
        // A suppressed or ambiguous send has no provider proof.
        p_provider_message_id: providerMessageId,
        p_error: errorMessage,
      },
    );
    if (error) {
      console.error(
        "[ownerNotify] claim completion failed",
        sanitizeProviderError(error),
      );
      return false;
    }
    const result = data as {
      success?: unknown;
      code?: unknown;
      status?: unknown;
    } | null;
    if (result?.success !== true || result.status !== status) {
      console.error(
        "[ownerNotify] claim completion rejected",
        typeof result?.code === "string"
          ? `${result.code}:status_mismatch`
          : "invalid_completion_response",
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      "[ownerNotify] claim completion threw",
      sanitizeProviderError(e),
    );
    return false;
  }
}

/**
 * Record one attempt. Never throws — the audit trail must not break the thing
 * it audits. Note the `await`: a PostgrestBuilder is lazy, so a bare `void
 * admin.from(...).insert(...)` would never actually run.
 */
async function logNotify(
  admin: ReturnType<typeof createServiceRoleClient>,
  row: NotifyLogRow,
): Promise<void> {
  try {
    const { error } = await admin.from("owner_notification_log").insert({
      salon_id: row.salonId,
      booking_id: row.bookingId ?? null,
      event: row.event,
      recipient: row.recipient ?? "",
      status: row.status,
      resend_id: row.resendId ?? null,
      error: row.error ?? null,
    } as never);
    if (error) {
      console.error(
        "[ownerNotify] log insert failed",
        sanitizeProviderError(error),
      );
    }
  } catch (e) {
    console.error(
      "[ownerNotify] log insert threw",
      sanitizeProviderError(e),
    );
  }
}

/**
 * Send one email per recipient rather than a single message addressed to all.
 * One suppressed or bouncing address then cannot hide the outcome for everyone
 * else, and recipients no longer see each other's addresses in the To: header.
 */
export async function sendToEachRecipient(
  admin: ReturnType<typeof createServiceRoleClient>,
  resend: ReturnType<typeof getResendClient>,
  recipients: string[],
  payload: { subject: string; html: string; text: string },
  meta: {
    salonId: string;
    bookingId?: string | null;
    event: string;
    eventOccurrenceKey?: string | null;
  },
): Promise<{ sent: number; failed: number }> {
  const from = getResendFrom();
  const results = await Promise.all(
    recipients.map(async (rawRecipient) => {
      const to = rawRecipient.trim().toLowerCase();
      const requiresBookingClaim = Boolean(
        meta.bookingId && isBookingEvent(meta.event),
      );
      if (requiresBookingClaim && !meta.eventOccurrenceKey) {
        await logNotify(admin, {
          ...meta,
          recipient: to,
          status: "skipped",
          error: "invalid_event_occurrence",
        });
        return false;
      }
      const bookingMeta =
        requiresBookingClaim &&
        meta.bookingId &&
        meta.eventOccurrenceKey &&
        isBookingEvent(meta.event)
          ? {
              salonId: meta.salonId,
              bookingId: meta.bookingId,
              event: meta.event,
              eventOccurrenceKey: meta.eventOccurrenceKey,
            }
          : null;
      let claimId: string | null = null;

      if (bookingMeta) {
        const claim = await claimOwnerRecipient(admin, bookingMeta, to);
        if (!claim.claimed) {
          await logNotify(admin, {
            ...meta,
            recipient: to,
            status: "skipped",
            error: claim.reason,
          });
          return false;
        }
        claimId = claim.claimId;
      }

      // Test/waitlist callers already short-circuit when Resend is absent.
      // For booking alerts, preserve a durable suppression instead of leaving
      // a sending claim or pretending a provider attempt occurred.
      if (!resend) {
        if (claimId) {
          const completed = await completeOwnerRecipientClaim(
            admin,
            claimId,
            "suppressed",
            null,
            "no_resend",
          );
          if (!completed) {
            await logNotify(admin, {
              ...meta,
              recipient: to,
              status: "failed",
              error: "claim_completion_failed:suppressed",
            });
            return false;
          }
        }
        await logNotify(admin, {
          ...meta,
          recipient: to,
          status: "skipped",
          error: "no_resend",
        });
        return false;
      }

      try {
        const res = await resend.emails.send({ from, to, ...payload });
        if (res.error) {
          const providerError = sanitizeProviderError(res.error);
          console.error(
            "[ownerNotify] resend error",
            recipientLogRef(to),
            providerError,
          );
          if (claimId) {
            const completed = await completeOwnerRecipientClaim(
              admin,
              claimId,
              "failed",
              null,
              providerError,
            );
            if (!completed) {
              await logNotify(admin, {
                ...meta,
                recipient: to,
                status: "failed",
                error: "claim_completion_failed:failed",
              });
              return false;
            }
          }
          await logNotify(admin, {
            ...meta,
            recipient: to,
            status: "failed",
            error: providerError,
          });
          return false;
        }
        const providerMessageId = res.data?.id?.trim() || null;
        if (!providerMessageId) {
          if (claimId) {
            const completed = await completeOwnerRecipientClaim(
              admin,
              claimId,
              "unknown",
              null,
              "provider_receipt_missing",
            );
            if (!completed) {
              await logNotify(admin, {
                ...meta,
                recipient: to,
                status: "failed",
                error: "claim_completion_failed:unknown",
              });
              return false;
            }
          }
          await logNotify(admin, {
            ...meta,
            recipient: to,
            status: "failed",
            error: "unknown:provider_receipt_missing",
          });
          return false;
        }
        if (claimId) {
          const completed = await completeOwnerRecipientClaim(
            admin,
            claimId,
            "sent",
            providerMessageId,
            null,
          );
          if (!completed) {
            await logNotify(admin, {
              ...meta,
              recipient: to,
              status: "failed",
              resendId: providerMessageId,
              error: "claim_completion_failed:provider_accepted",
            });
            return false;
          }
        }
        await logNotify(admin, {
          ...meta,
          recipient: to,
          status: "sent",
          resendId: providerMessageId,
        });
        return true;
      } catch (e) {
        const error = sanitizeProviderError(e);
        console.error(
          "[ownerNotify] send threw",
          recipientLogRef(to),
          error,
        );
        if (claimId) {
          const completed = await completeOwnerRecipientClaim(
            admin,
            claimId,
            "unknown",
            null,
            "provider_exception",
          );
          if (!completed) {
            await logNotify(admin, {
              ...meta,
              recipient: to,
              status: "failed",
              error: "claim_completion_failed:unknown",
            });
            return false;
          }
        }
        await logNotify(admin, {
          ...meta,
          recipient: to,
          status: "failed",
          error: `unknown:${error}`,
        });
        return false;
      }
    }),
  );
  const sent = results.filter(Boolean).length;
  return { sent, failed: results.length - sent };
}

/**
 * Send a one-off test email to the currently-configured recipients, ignoring
 * the per-event flags but honoring `enabled` + recipient resolution. Returns a
 * typed result so the Admin "Send test" button can show ✅ / ❌ + recipient count.
 */
export async function sendOwnerNotificationTest(
  salonId: string,
): Promise<
  | { ok: true; recipientCount: number }
  | { ok: false; error: "not_enabled" | "no_recipients" | "no_resend" | "send_failed" }
> {
  let admin: ReturnType<typeof createServiceRoleClient>;
  try {
    admin = createServiceRoleClient();
  } catch {
    return { ok: false, error: "send_failed" };
  }

  const { data: salonRow } = await admin
    .from("salons")
    .select("name, owner_notification_settings" as never)
    .eq("id", salonId)
    .maybeSingle();
  const salon = salonRow as {
    name?: string | null;
    owner_notification_settings?: unknown;
  } | null;
  if (!salon) return { ok: false, error: "send_failed" };

  const settings = parseOwnerNotificationSettings(
    salon.owner_notification_settings,
  );
  if (!settings.enabled) return { ok: false, error: "not_enabled" };

  const recipients = await resolveRecipients(
    admin,
    salonId,
    settings.notifyMembers,
    settings.customEmails,
  );
  if (recipients.length === 0) return { ok: false, error: "no_recipients" };

  const resend = getResendClient();
  if (!resend) return { ok: false, error: "no_resend" };

  const salonName = salon.name?.trim() || "NailIQ";
  // Same per-recipient path as a real alert, so a green test genuinely means
  // every configured address was reachable — not just the first one.
  const { sent } = await sendToEachRecipient(
    admin,
    resend,
    recipients,
    {
      subject: `[${salonName}] Test — Manager email alerts / Thông báo quản lý`,
      html: `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a">
  <h2 style="font-size:18px;margin:0 0 8px">✅ Manager email alerts are working</h2>
  <p style="margin:0 0 6px">Thông báo email cho quản lý đã hoạt động.</p>
  <p style="color:#666;margin:0">${esc(salonName)}</p>
</div>`,
      text: `Manager email alerts are working / Thông báo email cho quản lý đã hoạt động — ${salonName}`,
    },
    { salonId, event: "test" },
  );
  if (sent === 0) return { ok: false, error: "send_failed" };
  return { ok: true, recipientCount: sent };
}

/**
 * Notify owner/admins that a customer joined the online waitlist (their preferred
 * slot was full). Best-effort — never throws, never blocks the join. Honours the
 * same owner_notification_settings.enabled toggle + recipient resolution as
 * booking alerts.
 */
export async function sendOwnerWaitlistNotification(
  salonId: string,
  waitlistId: string,
): Promise<void> {
  try {
    if (!salonId || !waitlistId) return;
    let admin: ReturnType<typeof createServiceRoleClient>;
    try {
      admin = createServiceRoleClient();
    } catch {
      return;
    }

    const { data: salonRow } = await admin
      .from("salons")
      .select("name, timezone, owner_notification_settings" as never)
      .eq("id", salonId)
      .maybeSingle();
    const salon = salonRow as {
      name?: string | null;
      timezone?: string | null;
      owner_notification_settings?: unknown;
    } | null;
    if (!salon) return;

    const settings = parseOwnerNotificationSettings(salon.owner_notification_settings);
    if (!settings.enabled) return;

    const { data: entryRow } = await admin
      .from("booking_waitlist_entries" as never)
      .select(
        "service_id, booking_date, preferred_slot_label, client_name, service:service_id(name), staff:staff_id(name)",
      )
      .eq("id", waitlistId)
      .maybeSingle();
    const entry = entryRow as {
      service_id?: string | null;
      booking_date?: string | null;
      preferred_slot_label?: string | null;
      client_name?: string | null;
      service?: { name?: string | null } | null;
      staff?: { name?: string | null } | null;
    } | null;
    if (!entry) return;

    // How many are now waiting for this exact slot (salon + service + date).
    let waitingCount = 1;
    if (entry.service_id && entry.booking_date) {
      const { count } = await admin
        .from("booking_waitlist_entries" as never)
        .select("id", { count: "exact", head: true })
        .eq("salon_id", salonId)
        .eq("service_id", entry.service_id)
        .eq("booking_date", entry.booking_date)
        .eq("status", "waiting");
      if (typeof count === "number" && count > 0) waitingCount = count;
    }

    const recipients = await resolveRecipients(
      admin,
      salonId,
      settings.notifyMembers,
      settings.customEmails,
    );
    if (recipients.length === 0) return;

    const resend = getResendClient();
    if (!resend) return;

    const salonName = salon.name?.trim() || "NailIQ";
    const serviceName = entry.service?.name?.trim() || "a service";
    const staffName = entry.staff?.name?.trim() || null;
    const dateStr = entry.booking_date ?? "";
    const slot = entry.preferred_slot_label?.trim();
    const timeEn = slot ? `at ${slot}` : "(any time that day)";
    const timeVi = slot ? `lúc ${slot}` : "(cả ngày)";
    const staffEn = staffName ? ` with ${staffName}` : "";
    const staffVi = staffName ? ` với ${staffName}` : "";
    const client = entry.client_name?.trim() || "A customer";

    await sendToEachRecipient(
      admin,
      resend,
      recipients,
      {
        subject: `[${salonName}] New waitlist request / Khách vào danh sách chờ`,
        html: `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;max-width:520px">
  <h2 style="font-size:18px;margin:0 0 10px">🕒 New waitlist request</h2>
  <p style="margin:0 0 6px">${esc(client)} joined the waitlist for <strong>${esc(serviceName)}</strong> on <strong>${esc(dateStr)}</strong> ${esc(timeEn)}${esc(staffEn)}. That slot is currently full — ${waitingCount} now waiting. Consider opening a spot.</p>
  <p style="margin:12px 0 6px;color:#333">${esc(client)} vừa vào danh sách chờ cho <strong>${esc(serviceName)}</strong> ngày <strong>${esc(dateStr)}</strong> ${esc(timeVi)}${esc(staffVi)}. Slot này đang kín — hiện ${waitingCount} khách chờ. Cân nhắc mở thêm chỗ.</p>
  <p style="color:#666;margin:10px 0 0">${esc(salonName)}</p>
</div>`,
        text: `New waitlist request / Khách vào danh sách chờ — ${client}: ${serviceName} ${dateStr} ${timeEn}${staffEn} (${waitingCount} waiting) — ${salonName}`,
      },
      { salonId, event: "waitlist" },
    );
  } catch (e) {
    console.error(
      "[sendOwnerWaitlistNotification]",
      sanitizeProviderError(e),
    );
  }
}

/**
 * SERVER-ONLY. Needs the service-role client, so it must never be reached from
 * the browser — see the call-site notes in submitPublicBooking / submitGroupBooking.
 * Callers must keep the invocation alive with `after()`; a bare `void` is killed
 * when the serverless response flushes.
 */
export async function sendOwnerBookingNotification(
  input: OwnerNotifyInput,
): Promise<void> {
  try {
    const { salonId, bookingId, event } = input;
    if (!salonId || !bookingId) return;

    let admin: ReturnType<typeof createServiceRoleClient>;
    try {
      admin = createServiceRoleClient();
    } catch {
      return;
    }

    const { data: salonRow } = await admin
      .from("salons")
      .select(
        "name, slug, timezone, currency_code, owner_notification_settings" as never,
      )
      .eq("id", salonId)
      .maybeSingle();
    const salon = salonRow as {
      name?: string | null;
      slug?: string | null;
      timezone?: string | null;
      currency_code?: string | null;
      owner_notification_settings?: unknown;
    } | null;
    if (!salon) return;

    const settings = parseOwnerNotificationSettings(
      salon.owner_notification_settings,
    );
    if (!shouldNotify(settings, event)) return;

    const recipients = await resolveRecipients(
      admin,
      salonId,
      settings.notifyMembers,
      settings.customEmails,
    );
    // Misconfiguration, not an opt-out: leave a trail. (A `shouldNotify` miss
    // above is deliberate and would only flood the log, so it stays silent.)
    if (recipients.length === 0) {
      console.warn("[ownerNotify] no recipients resolved", salonId);
      await logNotify(admin, {
        salonId,
        bookingId,
        event,
        status: "skipped",
        error: "no_recipients",
      });
      return;
    }

    let resend: ReturnType<typeof getResendClient> = null;
    try {
      resend = getResendClient();
    } catch (e) {
      // Keep the per-recipient durable claim truthful even when provider
      // configuration is unavailable in production.
      console.error(
        "[ownerNotify] Resend unavailable",
        sanitizeProviderError(e),
      );
    }

    // Booking details + service/staff names.
    const { data: bRow } = await admin
      .from("bookings")
      .select(
        "client_name, client_phone, service_id, staff_id, start_time_utc, end_time_utc, status, source, booking_channel, price_cents, addon_price_cents, client_profile_id, created_at, updated_at",
      )
      .eq("id", bookingId)
      .eq("salon_id", salonId)
      .maybeSingle();
    const b = bRow as {
      client_name?: string | null;
      client_phone?: string | null;
      service_id?: string | null;
      staff_id?: string | null;
      start_time_utc?: string | null;
      end_time_utc?: string | null;
      status?: string | null;
      source?: string | null;
      booking_channel?: string | null;
      price_cents?: number | null;
      addon_price_cents?: number | null;
      client_profile_id?: string | null;
      created_at?: string | null;
      updated_at?: string | null;
    } | null;
    if (!b) return;

    const eventOccurrenceKey = ownerNotificationOccurrenceKey(event, {
      createdAt: b.created_at,
      updatedAt: b.updated_at,
      startTimeUtc: b.start_time_utc,
    });
    if (!eventOccurrenceKey) {
      await logNotify(admin, {
        salonId,
        bookingId,
        event,
        status: "skipped",
        error: "invalid_event_occurrence",
      });
      return;
    }

    // Defense in depth: never label an unchanged appointment as rescheduled.
    // The desk path already suppresses this, but this guard protects future
    // callers from equivalent ISO strings such as `+00:00` vs `.000Z`.
    if (event === "reschedule" && input.previousStartUtc && b.start_time_utc) {
      const comparison = compareBookingStartInstants(
        input.previousStartUtc,
        b.start_time_utc,
      );
      if (comparison.ok && !comparison.changed) {
        await logNotify(admin, {
          salonId,
          bookingId,
          event,
          status: "skipped",
          error: "same_start_instant",
        });
        return;
      }
    }

    const [svcRes, staffRes, profRes, vipRes] = await Promise.all([
      b.service_id
        ? admin
            .from("services")
            .select("name, duration_minutes, price_cents")
            .eq("id", b.service_id)
            .eq("salon_id", salonId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      b.staff_id
        ? admin
            .from("staff")
            .select("name")
            .eq("id", b.staff_id)
            .eq("salon_id", salonId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      b.client_profile_id
        ? admin
            .from("client_profiles")
            .select("visit_count, no_show_count")
            .eq("id", b.client_profile_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      b.client_profile_id
        ? admin
            .from("salon_clients" as never)
            .select("is_vip" as never)
            .eq("salon_id" as never, salonId)
            .eq("client_profile_id" as never, b.client_profile_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const svc = svcRes.data as {
      name?: string;
      duration_minutes?: number | null;
      price_cents?: number | null;
    } | null;
    const prof = profRes.data as {
      visit_count?: number | null;
      no_show_count?: number | null;
    } | null;
    const isSalonVip = (vipRes.data as { is_vip?: boolean | null } | null)?.is_vip === true;
    const serviceName = svc?.name?.trim() || "—";
    const staffName =
      (staffRes.data as { name?: string } | null)?.name?.trim() || "—";

    const tz = salon.timezone?.trim() || "America/Los_Angeles";
    const fmt = (utc?: string | null) =>
      utc
        ? `${formatInSalonTz(utc, tz, "date")} ${formatInSalonTz(utc, tz, "time")}`
        : "—";
    const customer = displayCustomerName(b.client_name ?? "", "[removed]");
    const salonName = salon.name?.trim() || "NailIQ";
    const label = EVENT_LABEL[event];
    const style = EVENT_STYLE[event];
    const origin = getEmailOrigin();
    const slug = salon.slug?.trim() ?? "";
    const dashboardUrl = slug ? `${origin}/dashboard/${slug}` : origin;
    const settingsUrl = slug
      ? `${origin}/dashboard/${slug}/settings`
      : origin;

    // Appointment date/time split for a prominent, glanceable time block.
    const dateStr = b.start_time_utc
      ? formatInSalonTz(b.start_time_utc, tz, "date")
      : "—";
    const timeStr = b.start_time_utc
      ? formatInSalonTz(b.start_time_utc, tz, "time")
      : "";

    // Duration: prefer end−start, fall back to the service's catalog length.
    let durationMin: number | null = null;
    if (b.start_time_utc && b.end_time_utc) {
      const mins = Math.round(
        (new Date(b.end_time_utc).getTime() -
          new Date(b.start_time_utc).getTime()) /
          60000,
      );
      if (mins > 0) durationMin = mins;
    }
    if (durationMin == null && svc?.duration_minutes)
      durationMin = svc.duration_minutes;

    // Price: booking snapshot (service + add-on) wins; else catalog price.
    const currency = salon.currency_code?.trim() || "USD";
    const bookingCents =
      (b.price_cents ?? 0) + (b.addon_price_cents ?? 0) || null;
    const priceStr = fmtMoney(bookingCents ?? svc?.price_cents, currency);

    const channelKey = (b.booking_channel || b.source || "").trim();
    const channelStr = CHANNEL_LABEL[channelKey] || null;
    const phone = b.client_phone?.trim() || null;
    const changedByLabel = ownerNotificationActorLabel(input.changedBy);
    const changedFieldsLabel = ownerNotificationChangesLabel(input.changedFields);

    // Customer recognition badge (no-show history → VIP → new → returning).
    const visits = prof?.visit_count ?? 0;
    const noShows = prof?.no_show_count ?? 0;
    let custBadge: { text: string; bg: string; fg: string } | null = null;
    if (noShows > 0) {
      custBadge = {
        text: `⚠ ${noShows} no-show · Từng vắng`,
        bg: "#fee2e2",
        fg: "#991b1b",
      };
    } else if (isSalonVip) {
      custBadge = { text: "★ VIP", bg: "#fef3c7", fg: "#92400e" };
    } else if (visits <= 1) {
      custBadge = {
        text: "New customer · Khách mới",
        bg: "#dcfce7",
        fg: "#166534",
      };
    } else {
      custBadge = {
        text: `Returning · Khách quen · ${visits}×`,
        bg: "#dbeafe",
        fg: "#1e40af",
      };
    }

    // Group badge — email represents a whole party, not one guest.
    const groupSize =
      input.groupSize && input.groupSize > 1
        ? Math.floor(input.groupSize)
        : null;
    const groupBadgeHtml = groupSize
      ? ` <span style="display:inline-block;background:#ede9fe;color:#5b21b6;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px">👥 Group · Nhóm · ${groupSize}</span>`
      : "";

    // ── Detail rows (only render what we actually have) ──
    const detail: Array<[string, string]> = [
      ["Service · Dịch vụ", durationMin ? `${serviceName} · ${durationMin} min` : serviceName],
    ];
    if (priceStr) detail.push(["Price · Giá", priceStr]);
    detail.push(["Staff · Thợ", staffName]);
    if (event === "reschedule" && changedByLabel) {
      detail.push(["Changed by · Người thay đổi", changedByLabel]);
    }
    if (event === "reschedule" && changedFieldsLabel) {
      detail.push(["Changed · Nội dung", changedFieldsLabel]);
    }
    if (channelStr) {
      detail.push(["Original booking source · Nguồn đặt ban đầu", channelStr]);
    }
    const detailHtml = detail
      .map(
        ([k, v], i) =>
          `<tr><td style="padding:9px 0;${
            i ? "border-top:1px solid #f0f1f3;" : ""
          }color:#6b7280;font-size:13px;vertical-align:top">${esc(
            k,
          )}</td><td style="padding:9px 0;${
            i ? "border-top:1px solid #f0f1f3;" : ""
          }color:#111827;font-size:14px;font-weight:600;text-align:right">${esc(
            v,
          )}</td></tr>`,
      )
      .join("");

    const rescheduleTime =
      event === "reschedule" && input.previousStartUtc && b.start_time_utc
        ? ownerRescheduleTimeLabels({
            previousStartUtc: input.previousStartUtc,
            nextStartUtc: b.start_time_utc,
            timezone: tz,
            durationMin,
          })
        : null;
    const appointmentTimeHtml = rescheduleTime
      ? `<div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Before · Trước khi đổi</div>
            <div style="font-size:14px;color:#6b7280;margin-top:5px"><s>${esc(rescheduleTime.before)}</s></div>
            <div style="font-size:18px;color:${style.accent};font-weight:700;margin:8px 0">↓</div>
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">After · Sau khi đổi</div>
            <div style="font-size:19px;font-weight:700;color:#111827;margin-top:5px">${esc(rescheduleTime.afterDate)}</div>
            <div style="font-size:15px;color:#374151;margin-top:2px">${esc(rescheduleTime.afterTime)}</div>`
      : `<div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Appointment · Lịch hẹn</div>
            <div style="font-size:19px;font-weight:700;color:#111827;margin-top:5px">${esc(dateStr)}</div>
            <div style="font-size:15px;color:#374151;margin-top:2px">${esc(timeStr)}${durationMin ? ` · ${durationMin} min` : ""}</div>`;

    const phoneHtml = phone
      ? `<a href="tel:${esc(phone.replace(/[^\d+]/g, ""))}" style="display:inline-block;margin-top:8px;color:#374151;font-size:14px;text-decoration:none">📞 ${esc(
          phone,
        )}</a>`
      : "";

    const subject = `[${salonName}] ${label.en} / ${label.vi} — ${customer}${
      groupSize ? ` (Nhóm ${groupSize})` : ""
    }`;
    const html = `<div style="margin:0;padding:24px 12px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto"><tr><td>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B0C10;border-radius:14px 14px 0 0"><tr>
      <td style="padding:18px 24px"><span style="color:#D4AF37;font-size:15px;font-weight:700;letter-spacing:2px">NAILIQ</span></td>
      <td style="padding:18px 24px;text-align:right"><span style="color:#9ca3af;font-size:11px;letter-spacing:1.5px;text-transform:uppercase">Manager alert</span></td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 14px 14px"><tr>
      <td style="padding:24px;border-left:4px solid ${style.accent};border-radius:0 0 0 14px">
        <span style="display:inline-block;background:${style.badgeBg};color:${style.badgeText};font-size:13px;font-weight:700;padding:6px 13px;border-radius:999px">${style.emoji} ${esc(label.en)} · ${esc(label.vi)}</span>
        <p style="color:#6b7280;font-size:13px;margin:12px 0 0">${esc(salonName)}</p>
        <h1 style="font-size:22px;font-weight:800;color:#111827;margin:14px 0 8px">${esc(customer)}</h1>
        <div><span style="display:inline-block;background:${custBadge.bg};color:${custBadge.fg};font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px">${esc(custBadge.text)}</span>${groupBadgeHtml}</div>
        ${phoneHtml}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #eef0f2;border-radius:10px;margin:18px 0"><tr>
          <td style="padding:14px 16px">
            ${appointmentTimeHtml}
          </td>
        </tr></table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${detailHtml}</table>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 2px"><tr>
          <td style="border-radius:10px;background:#D4AF37"><a href="${dashboardUrl}" style="display:inline-block;padding:12px 24px;color:#0B0C10;font-size:14px;font-weight:700;text-decoration:none">Open dashboard · Mở bảng điều khiển →</a></td>
        </tr></table>
      </td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="text-align:center;padding:18px 24px 4px">
        <p style="color:#9ca3af;font-size:12px;margin:0 0 4px">Manager email alerts for ${esc(salonName)} · Thông báo quản lý</p>
        <p style="color:#9ca3af;font-size:12px;margin:0"><a href="${settingsUrl}" style="color:#6b7280;text-decoration:underline">Manage alerts · Cài đặt</a></p>
        <p style="color:#c4c7cc;font-size:11px;margin:12px 0 0">Powered by <span style="color:#9ca3af;font-weight:700">NailIQ</span></p>
      </td>
    </tr></table>
  </td></tr></table>
</div>`;
    const textLines = [
      `${label.en} / ${label.vi} — ${salonName}`,
      "",
      `Customer / Khách: ${customer} (${custBadge.text})`,
      ...(groupSize ? [`Group / Nhóm: ${groupSize} người`] : []),
      ...(phone ? [`Phone / SĐT: ${phone}`] : []),
      `Service / Dịch vụ: ${serviceName}${durationMin ? ` · ${durationMin} min` : ""}`,
      ...(priceStr ? [`Price / Giá: ${priceStr}`] : []),
      `Staff / Thợ: ${staffName}`,
      ...(event === "reschedule" && changedByLabel
        ? [`Changed by / Người thay đổi: ${changedByLabel}`]
        : []),
      ...(event === "reschedule" && changedFieldsLabel
        ? [`Changed / Nội dung: ${changedFieldsLabel}`]
        : []),
      ...(channelStr
        ? [`Original booking source / Nguồn đặt ban đầu: ${channelStr}`]
        : []),
      ...(rescheduleTime
        ? [
            `Before / Trước khi đổi: ${rescheduleTime.before}`,
            `After / Sau khi đổi: ${rescheduleTime.afterDate} ${rescheduleTime.afterTime}`,
          ]
        : [`Time / Giờ: ${fmt(b.start_time_utc)}`]),
      "",
      `Open dashboard: ${dashboardUrl}`,
    ];
    const text = textLines.join("\n");

    await sendToEachRecipient(
      admin,
      resend,
      recipients,
      { subject, html, text },
      { salonId, bookingId, event, eventOccurrenceKey },
    );
  } catch (e) {
    console.error("[ownerNotify]", sanitizeProviderError(e));
  }
}
