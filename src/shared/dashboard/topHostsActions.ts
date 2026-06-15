"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";

/**
 * "Top người dẫn nhóm" — the salon's biggest group organizers (by guests
 * brought) + a one-tap "Tặng VIP". Owner-only. The VIP write upserts
 * client_profiles by phone so it works even for a host who has no profile row
 * yet (e.g. an old group organizer who only ever booked as a group).
 */

export type TopHost = {
  phone: string;
  name: string | null;
  isVip: boolean;
  groupsOrganized: number;
  guestsBrought: number;
};

export type LoadTopHostsResult =
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" }
  | { ok: true; hosts: TopHost[] };

export type SetHostVipResult =
  | { ok: false; error: "unauthorized" | "forbidden" | "invalid" | "server_error" }
  | { ok: true; isVip: boolean };

export async function loadTopHosts(slug: string): Promise<LoadTopHostsResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (ctx.role !== "owner" && ctx.role !== "admin")
    return { ok: false, error: "forbidden" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[loadTopHosts] service role", e);
    return { ok: false, error: "server_error" };
  }

  type Row = {
    phone?: string | null;
    name?: string | null;
    is_vip?: boolean | null;
    groups_organized?: number | null;
    guests_brought?: number | null;
  };
  const { data, error } = (await admin.rpc("top_salon_hosts" as never, {
    p_salon_id: ctx.salon.id,
    p_limit: 10,
  } as never)) as { data: Row[] | null; error: unknown };

  if (error) {
    console.error("[loadTopHosts] rpc", error);
    return { ok: false, error: "server_error" };
  }

  const hosts: TopHost[] = (data ?? [])
    .filter((r) => typeof r.phone === "string" && r.phone.length > 0)
    .map((r) => ({
      phone: String(r.phone),
      name: r.name?.trim() || null,
      isVip: r.is_vip === true,
      groupsOrganized: Number(r.groups_organized ?? 0),
      guestsBrought: Number(r.guests_brought ?? 0),
    }));

  return { ok: true, hosts };
}

export async function setHostVip(
  slug: string,
  phone: string,
  isVip: boolean,
): Promise<SetHostVipResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (ctx.role !== "owner" && ctx.role !== "admin")
    return { ok: false, error: "forbidden" };

  const canonical = toCanonicalPhone(phone);
  if (!canonical) return { ok: false, error: "invalid" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[setHostVip] service role", e);
    return { ok: false, error: "server_error" };
  }

  // Upsert by phone so a host with no profile row still gets the VIP flag.
  // Only phone + is_vip are written: a brand-new row gets a null name (the
  // directory falls back to the booking name) and an existing row keeps its
  // real name untouched.
  const { error } = await admin
    .from("client_profiles")
    .upsert(
      { phone: canonical, is_vip: isVip, updated_at: new Date().toISOString() } as never,
      { onConflict: "phone" },
    );

  if (error) {
    console.error("[setHostVip] upsert", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true, isVip };
}

export type HostGroup = {
  groupId: string;
  startedAt: string | null;
  status: string;
  service: string | null;
  size: number;
  attendees: string[];
};

export type LoadHostGroupsResult =
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" }
  | { ok: true; groups: HostGroup[] };

/** The groups a host organized (newest first) + who they brought — for the
 *  host detail drawer. Owner/admin only, salon-gated. */
export async function loadHostGroups(
  slug: string,
  phone: string,
): Promise<LoadHostGroupsResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (ctx.role !== "owner" && ctx.role !== "admin")
    return { ok: false, error: "forbidden" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[loadHostGroups] service role", e);
    return { ok: false, error: "server_error" };
  }

  type Row = {
    group_id?: string | null;
    started_at?: string | null;
    status?: string | null;
    service?: string | null;
    size?: number | null;
    attendees?: string[] | null;
  };
  const { data, error } = (await admin.rpc("get_host_groups" as never, {
    p_salon_id: ctx.salon.id,
    p_phone: phone,
    p_limit: 20,
  } as never)) as { data: Row[] | null; error: unknown };

  if (error) {
    console.error("[loadHostGroups] rpc", error);
    return { ok: false, error: "server_error" };
  }

  const groups: HostGroup[] = (data ?? [])
    .filter((r) => typeof r.group_id === "string")
    .map((r) => ({
      groupId: String(r.group_id),
      startedAt: r.started_at?.trim() ? String(r.started_at) : null,
      status: String(r.status ?? ""),
      service: r.service?.trim() || null,
      size: Number(r.size ?? 0),
      attendees: Array.isArray(r.attendees)
        ? r.attendees.filter((a): a is string => typeof a === "string")
        : [],
    }));

  return { ok: true, groups };
}
