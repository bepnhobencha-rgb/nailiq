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
        "client_name, client_phone, service_id, staff_id, start_time_utc, end_time_utc, status, source, booking_channel, price_cents, addon_price_cents, client_profile_id",
      )
      .eq("id", bookingId)
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
    } | null;
    if (!b) return;

    const [svcRes, staffRes, profRes] = await Promise.all([
      b.service_id
        ? admin
            .from("services")
            .select("name, duration_minutes, price_cents")
            .eq("id", b.service_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      b.staff_id
        ? admin.from("staff").select("name").eq("id", b.staff_id).maybeSingle()
        : Promise.resolve({ data: null }),
      b.client_profile_id
        ? admin
            .from("client_profiles")
            .select("visit_count, no_show_count, is_vip")
            .eq("id", b.client_profile_id)
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
      is_vip?: boolean | null;
    } | null;
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
    } else if (prof?.is_vip) {
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
    if (channelStr) detail.push(["Channel · Kênh", channelStr]);
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

    const oldTimeHtml =
      event === "reschedule" && input.previousStartUtc
        ? `<div style="font-size:13px;color:#6b7280;margin-top:6px">Old time · Giờ cũ: <s>${esc(
            fmt(input.previousStartUtc),
          )}</s></div>`
        : "";

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
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Appointment · Lịch hẹn</div>
            <div style="font-size:19px;font-weight:700;color:#111827;margin-top:5px">${esc(dateStr)}</div>
            <div style="font-size:15px;color:#374151;margin-top:2px">${esc(timeStr)}${durationMin ? ` · ${durationMin} min` : ""}</div>
            ${oldTimeHtml}
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
      ...(channelStr ? [`Channel / Kênh: ${channelStr}`] : []),
      `Time / Giờ: ${fmt(b.start_time_utc)}`,
      ...(event === "reschedule" && input.previousStartUtc
        ? [`Old time / Giờ cũ: ${fmt(input.previousStartUtc)}`]
        : []),
      "",
      `Open dashboard: ${dashboardUrl}`,
    ];
    const text = textLines.join("\n");

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
