import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { formatInSalonTz } from "@/shared/lib/salonTime";
import { displayCustomerName } from "@/shared/lib/customerDisplayName";
import {
  parseOwnerNotificationSettings,
  shouldNotify,
  type OwnerNotificationEvent,
} from "@/shared/dashboard/ownerNotificationSettings";

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
};

const EVENT_LABEL: Record<OwnerNotificationEvent, { en: string; vi: string }> = {
  new: { en: "New booking", vi: "Đặt hẹn mới" },
  reschedule: { en: "Booking rescheduled", vi: "Đổi giờ hẹn" },
  cancel: { en: "Booking cancelled", vi: "Huỷ hẹn" },
  no_show: { en: "No-show", vi: "Khách không đến" },
};

const esc = (s: string) =>
  s.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
  );

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
  const res = await resend.emails.send({
    from: getResendFrom(),
    to: recipients,
    subject: `[${salonName}] Test — Manager email alerts / Thông báo quản lý`,
    html: `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a">
  <h2 style="font-size:18px;margin:0 0 8px">✅ Manager email alerts are working</h2>
  <p style="margin:0 0 6px">Thông báo email cho quản lý đã hoạt động.</p>
  <p style="color:#666;margin:0">${esc(salonName)}</p>
</div>`,
    text: `Manager email alerts are working / Thông báo email cho quản lý đã hoạt động — ${salonName}`,
  });
  if (res.error) {
    console.error("[ownerNotify/test] resend error", res.error);
    return { ok: false, error: "send_failed" };
  }
  return { ok: true, recipientCount: recipients.length };
}

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
      .select("name, timezone, owner_notification_settings" as never)
      .eq("id", salonId)
      .maybeSingle();
    const salon = salonRow as {
      name?: string | null;
      timezone?: string | null;
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
    if (recipients.length === 0) return;

    const resend = getResendClient();
    if (!resend) {
      console.warn("[ownerNotify] no RESEND_API_KEY — skipping");
      return;
    }

    // Booking details + service/staff names.
    const { data: bRow } = await admin
      .from("bookings")
      .select(
        "client_name, service_id, staff_id, start_time_utc, status",
      )
      .eq("id", bookingId)
      .maybeSingle();
    const b = bRow as {
      client_name?: string | null;
      service_id?: string | null;
      staff_id?: string | null;
      start_time_utc?: string | null;
      status?: string | null;
    } | null;
    if (!b) return;

    const [svcRes, staffRes] = await Promise.all([
      b.service_id
        ? admin.from("services").select("name").eq("id", b.service_id).maybeSingle()
        : Promise.resolve({ data: null }),
      b.staff_id
        ? admin.from("staff").select("name").eq("id", b.staff_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const serviceName =
      (svcRes.data as { name?: string } | null)?.name?.trim() || "—";
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

    const rows: Array<[string, string]> = [
      ["Customer / Khách", customer],
      ["Service / Dịch vụ", serviceName],
      ["Staff / Thợ", staffName],
      ["Time / Giờ", fmt(b.start_time_utc)],
    ];
    if (event === "reschedule" && input.previousStartUtc) {
      rows.splice(3, 0, ["Old time / Giờ cũ", fmt(input.previousStartUtc)]);
    }

    const subject = `[${salonName}] ${label.en} / ${label.vi} — ${customer}`;
    const rowsHtml = rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap">${esc(
            k,
          )}</td><td style="padding:4px 0;font-weight:600">${esc(v)}</td></tr>`,
      )
      .join("");
    const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a">
  <h2 style="font-size:18px;margin:0 0 4px">${esc(label.en)} · ${esc(label.vi)}</h2>
  <p style="color:#666;margin:0 0 12px">${esc(salonName)}</p>
  <table style="border-collapse:collapse;font-size:14px">${rowsHtml}</table>
</div>`;
    const text = `${label.en} / ${label.vi} — ${salonName}\n${rows
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")}`;

    const res = await resend.emails.send({
      from: getResendFrom(),
      to: recipients,
      subject,
      html,
      text,
    });
    if (res.error) {
      console.error("[ownerNotify] resend error", res.error);
    }
  } catch (e) {
    console.error("[ownerNotify]", e);
  }
}
