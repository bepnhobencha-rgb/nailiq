"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendSmsReminder } from "@/shared/lib/twilioSms";

export type RsvpPageData =
  | {
      ok: true;
      bookingId: string;
      salonName: string;
      salonSlug: string;
      timezone: string;
      serviceName: string;
      staffName: string;
      startAt: string;
      memberName: string;
      organizerName: string;
      groupSize: number;
      currentStatus: "pending" | "confirmed" | "declined" | null;
    }
  | { ok: false; code: string };

export async function loadRsvpPageData(token: string): Promise<RsvpPageData> {
  if (!token) return { ok: false, code: "missing_token" };

  const db = createServiceRoleClient();

  // 1. Resolve token → booking_id
  const { data: tokenRow } = await db
    .from("booking_reminder_tokens" as never)
    .select("booking_id, expires_at")
    .eq("id", token)
    .maybeSingle();

  if (!tokenRow) return { ok: false, code: "not_found" };
  const t = tokenRow as { booking_id: string; expires_at: string };
  if (new Date(t.expires_at) < new Date()) return { ok: false, code: "expired" };

  // 2. Load booking
  const { data: booking } = await db
    .from("bookings" as never)
    .select("id, client_name, group_id, salon_id, service_name, staff_name, start_at, attendance_status")
    .eq("id", t.booking_id)
    .maybeSingle();

  if (!booking) return { ok: false, code: "booking_not_found" };
  const b = booking as {
    id: string;
    client_name: string | null;
    group_id: string | null;
    salon_id: string;
    service_name: string | null;
    staff_name: string | null;
    start_at: string;
    attendance_status: string | null;
  };

  // 3. Load salon
  const { data: salon } = await db
    .from("salons" as never)
    .select("name, slug, timezone")
    .eq("id", b.salon_id)
    .maybeSingle();

  if (!salon) return { ok: false, code: "salon_not_found" };
  const s = salon as { name: string; slug: string; timezone: string };

  // 4. Load organizer name + group size from party_links
  let organizerName = "";
  let groupSize = 1;
  if (b.group_id) {
    const { data: pl } = await db
      .from("party_links" as never)
      .select("organizer_name")
      .eq("group_id", b.group_id)
      .maybeSingle();
    organizerName = (pl as { organizer_name?: string | null } | null)?.organizer_name ?? "";

    const { count } = await db
      .from("bookings" as never)
      .select("id", { count: "exact", head: true })
      .eq("group_id", b.group_id);
    groupSize = count ?? 1;
  }

  return {
    ok: true,
    bookingId: b.id,
    salonName: s.name,
    salonSlug: s.slug,
    timezone: s.timezone ?? "America/Vancouver",
    serviceName: b.service_name ?? "",
    staffName: b.staff_name ?? "",
    startAt: b.start_at,
    memberName: b.client_name ?? "",
    organizerName,
    groupSize,
    currentStatus: (b.attendance_status as "pending" | "confirmed" | "declined" | null) ?? null,
  };
}

export async function confirmMemberAttendance(
  bookingId: string,
  token: string,
): Promise<{ ok: boolean; code?: string }> {
  const db = createServiceRoleClient();
  const { data } = await db.rpc("confirm_party_member" as never, {
    p_booking_id: bookingId,
    p_token: token,
  } as never);
  const res = data as { ok?: boolean; code?: string } | null;
  return { ok: res?.ok === true, code: res?.code };
}

export async function declineMemberAttendance(
  bookingId: string,
  token: string,
  suggestedName?: string,
  suggestedPhone?: string,
): Promise<{ ok: boolean; code?: string }> {
  const db = createServiceRoleClient();

  const { data } = await db.rpc("decline_party_member" as never, {
    p_booking_id: bookingId,
    p_token: token,
    p_suggested_name: suggestedName ?? null,
    p_suggested_phone: suggestedPhone ?? null,
  } as never);

  const res = data as { ok?: boolean; code?: string } | null;
  if (res?.ok !== true) return { ok: false, code: res?.code };

  // Notify organizer via SMS (best-effort)
  void notifyOrganizer(bookingId, db, suggestedName, suggestedPhone);

  return { ok: true };
}

async function notifyOrganizer(
  bookingId: string,
  db: ReturnType<typeof createServiceRoleClient>,
  suggestedName?: string,
  suggestedPhone?: string,
) {
  try {
    // Get booking to find group_id + member name
    const { data: booking } = await db
      .from("bookings" as never)
      .select("group_id, client_name")
      .eq("id", bookingId)
      .maybeSingle();

    const b = booking as { group_id: string | null; client_name: string | null } | null;
    if (!b?.group_id) return;

    // Get organizer phone + salon info from party_links
    const { data: pl } = await db
      .from("party_links" as never)
      .select("organizer_phone, organizer_name, salon_id, token")
      .eq("group_id", b.group_id)
      .maybeSingle();

    const partyLink = pl as {
      organizer_phone: string | null;
      organizer_name: string | null;
      salon_id: string;
      token: string;
    } | null;
    if (!partyLink?.organizer_phone) return;

    // Get salon name + slug for the party link URL
    const { data: salon } = await db
      .from("salons" as never)
      .select("name, slug")
      .eq("id", partyLink.salon_id)
      .maybeSingle();
    const salonSlug = (salon as { slug?: string } | null)?.slug ?? "";

    const memberName = b.client_name ?? "Một thành viên";
    const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca").trim();
    const partyUrl = `${SITE_URL}/party/${partyLink.token}`;

    let msg = `${memberName} không đến được trong nhóm của bạn.`;
    if (suggestedName && suggestedPhone) {
      msg += ` Đề xuất thay: ${suggestedName} (${suggestedPhone}).`;
    }
    msg += ` Quản lý nhóm: ${partyUrl}`;

    const salonIsTest =
      /^e2e[-_]/i.test(salonSlug) || /^e2e\b/i.test((salon as { name?: string } | null)?.name ?? "");

    await sendSmsReminder(partyLink.organizer_phone, msg, { salonIsTest, lang: "vi" });

    // Mark notified
    await db
      .from("party_link_claims" as never)
      .update({ organizer_notified_at: new Date().toISOString() } as never)
      .eq("booking_id", bookingId);
  } catch {
    // Notification is best-effort — swallow errors
  }
}
