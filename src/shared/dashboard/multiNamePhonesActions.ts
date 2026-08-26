"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { loadSalonVipPhones } from "@/shared/dashboard/salonVipStatus";

/**
 * "Một số — nhiều tên": phones whose bookings carry 2+ distinct real names
 * (family / shared line / typos / legacy group pollution). Phone is the
 * identity; this lets the owner pick ONE canonical display name per phone.
 * Owner-only. setClientName upserts client_profiles by phone so it works even
 * when no profile row exists yet.
 */

export type NameVariant = { name: string; count: number };

export type MultiNamePhone = {
  phone: string;
  profileName: string | null;
  isVip: boolean;
  distinctNames: number;
  totalVisits: number;
  variants: NameVariant[];
};

export type LoadMultiNamePhonesResult =
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" }
  | { ok: true; phones: MultiNamePhone[] };

export type SetClientNameResult =
  | { ok: false; error: "unauthorized" | "forbidden" | "invalid" | "server_error" }
  | { ok: true; name: string };

export async function loadMultiNamePhones(
  slug: string,
): Promise<LoadMultiNamePhonesResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role))
    return { ok: false, error: "forbidden" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[loadMultiNamePhones] service role", e);
    return { ok: false, error: "server_error" };
  }

  type Row = {
    phone?: string | null;
    profile_name?: string | null;
    is_vip?: boolean | null;
    distinct_names?: number | null;
    total_visits?: number | null;
    variants?: unknown;
  };
  const { data, error } = (await admin.rpc("salon_multi_name_phones" as never, {
    p_salon_id: ctx.salon.id,
    p_limit: 25,
  } as never)) as { data: Row[] | null; error: unknown };

  if (error) {
    console.error("[loadMultiNamePhones] rpc", error);
    return { ok: false, error: "server_error" };
  }

  const sourceRows = (data ?? []).filter(
    (r) => typeof r.phone === "string" && r.phone.length > 0,
  );
  let vipPhones = new Set<string>();
  try {
    vipPhones = await loadSalonVipPhones(
      ctx.salon.id,
      sourceRows.map((row) => String(row.phone)),
    );
  } catch (vipError) {
    console.error("[loadMultiNamePhones] salon vip status", vipError);
  }
  const phones: MultiNamePhone[] = sourceRows
    .map((r) => ({
      phone: String(r.phone),
      profileName: r.profile_name?.trim() || null,
      isVip: vipPhones.has(String(r.phone)),
      distinctNames: Number(r.distinct_names ?? 0),
      totalVisits: Number(r.total_visits ?? 0),
      variants: Array.isArray(r.variants)
        ? (r.variants as NameVariant[])
            .filter((v) => v && typeof v.name === "string")
            .map((v) => ({ name: String(v.name), count: Number(v.count ?? 0) }))
        : [],
    }));

  return { ok: true, phones };
}

export async function setClientName(
  slug: string,
  phone: string,
  name: string,
): Promise<SetClientNameResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role))
    return { ok: false, error: "forbidden" };

  const canonical = toCanonicalPhone(phone);
  const cleanName = (name ?? "").trim().slice(0, 200);
  if (!canonical || !cleanName) return { ok: false, error: "invalid" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[setClientName] service role", e);
    return { ok: false, error: "server_error" };
  }

  // Upsert by phone so it works whether or not a profile row exists. Sets the
  // canonical display name only — never touches visit_count or other fields.
  const { error } = await admin
    .from("client_profiles")
    .upsert(
      { phone: canonical, name: cleanName, updated_at: new Date().toISOString() } as never,
      { onConflict: "phone" },
    );

  if (error) {
    console.error("[setClientName] upsert", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true, name: cleanName };
}
