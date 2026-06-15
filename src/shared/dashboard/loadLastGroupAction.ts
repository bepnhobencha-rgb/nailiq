"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";

/**
 * "Đặt lại nhóm gần nhất" — loads a host's most recent group booking as a
 * reusable template so the front desk can rebook the same party (same members,
 * services, preferred staff) for a new date without retyping. Read-only,
 * salon-membership gated. The actual rebooking reuses the verified group
 * scheduler + createDeskGroup — this only returns a prefill.
 */

export type RebookMember = {
  name: string;
  serviceId: string;
  preferredStaffId: string | null;
  addonServiceIds: string[];
};

export type LoadLastGroupResult =
  | { ok: false; error: "unauthorized" | "invalid_phone" | "server_error" }
  | { ok: true; found: false }
  | {
      ok: true;
      found: true;
      memberCount: number;
      lastStartUtc: string | null;
      members: RebookMember[];
    };

export async function loadLastGroup(
  slug: string,
  phone: string,
): Promise<LoadLastGroupResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const canonical = toCanonicalPhone(phone);
  if (!canonical) return { ok: false, error: "invalid_phone" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[loadLastGroup] service role", e);
    return { ok: false, error: "server_error" };
  }

  // Most recent group THIS phone organized at THIS salon.
  type OrgRow = { group_id: string | null; start_time_utc: string | null };
  const { data: orgData, error: orgErr } = (await admin
    .from("bookings")
    .select("group_id, start_time_utc")
    .eq("salon_id", ctx.salon.id)
    .eq("client_phone", canonical)
    .eq("is_group_organizer", true)
    .neq("status", "cancelled")
    .not("group_id", "is", null)
    .order("start_time_utc", { ascending: false })
    .limit(1)) as { data: OrgRow[] | null; error: unknown };

  if (orgErr) {
    console.error("[loadLastGroup] organizer lookup", orgErr);
    return { ok: false, error: "server_error" };
  }
  const groupId = orgData?.[0]?.group_id ?? null;
  if (!groupId) return { ok: true, found: false };

  // All live members of that group, organizer first.
  type MemberRow = {
    client_name: string | null;
    service_id: string | null;
    staff_id: string | null;
    addon_service_id: string | null;
    wave_number: number | null;
    is_group_organizer: boolean | null;
    start_time_utc: string | null;
  };
  const { data: memberData, error: memErr } = (await admin
    .from("bookings")
    .select(
      "client_name, service_id, staff_id, addon_service_id, wave_number, is_group_organizer, start_time_utc",
    )
    .eq("group_id", groupId)
    .neq("status", "cancelled")
    .order("is_group_organizer", { ascending: false })
    .order("wave_number", { ascending: true })
    .order("start_time_utc", { ascending: true })) as {
    data: MemberRow[] | null;
    error: unknown;
  };

  if (memErr) {
    console.error("[loadLastGroup] members", memErr);
    return { ok: false, error: "server_error" };
  }

  const rows = memberData ?? [];
  if (rows.length === 0) return { ok: true, found: false };

  const members: RebookMember[] = rows.map((r) => ({
    name: (r.client_name ?? "").trim(),
    serviceId: r.service_id ?? "",
    preferredStaffId: r.staff_id ?? null,
    addonServiceIds: r.addon_service_id ? [String(r.addon_service_id)] : [],
  }));

  return {
    ok: true,
    found: true,
    memberCount: members.length,
    lastStartUtc: rows[0]?.start_time_utc ?? null,
    members,
  };
}
