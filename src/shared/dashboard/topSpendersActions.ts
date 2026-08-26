"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  parseVipSpendTiers,
  spendTier,
  type VipTier,
} from "@/shared/dashboard/vipSpendTier";
import { loadSalonVipPhones } from "@/shared/dashboard/salonVipStatus";

/**
 * "Top khách chi tiêu" — the salon's biggest spenders, by real money paid
 * (synced from Square into salon_client_spend). Owner/admin only. One-tap VIP
 * reuses setHostVip (topHostsActions). Names prefer the per-salon override.
 */
export type TopSpender = {
  phone: string;
  name: string | null;
  isVip: boolean;
  totalSpendCents: number;
  paymentCount: number;
  lastPaymentAt: string | null;
  tier: VipTier;
};

export type LoadTopSpendersResult =
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" }
  | { ok: true; spenders: TopSpender[] };

export async function loadTopSpenders(slug: string): Promise<LoadTopSpendersResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[loadTopSpenders] service role", e);
    return { ok: false, error: "server_error" };
  }

  type Row = {
    total_spend_cents?: number | null;
    payment_count?: number | null;
    last_payment_at?: string | null;
    client_profiles?: { phone?: string | null; name?: string | null } | null;
  };
  const { data, error } = await admin
    .from("salon_client_spend")
    .select("total_spend_cents, payment_count, last_payment_at, client_profiles(phone, name)")
    .eq("salon_id", ctx.salon.id)
    .order("total_spend_cents", { ascending: false })
    .limit(15);

  if (error) {
    console.error("[loadTopSpenders] query", error);
    return { ok: false, error: "server_error" };
  }

  const rows = ((data as Row[] | null) ?? []).filter(
    (r) => typeof r.client_profiles?.phone === "string" && (r.client_profiles?.phone ?? "").length > 0,
  );

  // Per-salon display-name override (tenant-isolated rename) wins over the
  // shared profile name.
  const phones = rows.map((r) => String(r.client_profiles!.phone));
  let vipPhones = new Set<string>();
  try {
    vipPhones = await loadSalonVipPhones(ctx.salon.id, phones);
  } catch (vipError) {
    console.error("[loadTopSpenders] salon vip status", vipError);
  }
  const overrides = new Map<string, string>();
  if (phones.length > 0) {
    const { data: ov } = await admin
      .from("salon_client_names")
      .select("phone, display_name")
      .eq("salon_id", ctx.salon.id)
      .in("phone", phones);
    for (const o of (ov as { phone: string; display_name: string }[] | null) ?? []) {
      if (o.display_name?.trim()) overrides.set(o.phone, o.display_name.trim());
    }
  }

  // Per-salon VIP tier thresholds (NULL → code defaults).
  const { data: salonRow } = await admin
    .from("salons")
    .select("vip_spend_tiers")
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const tiers = parseVipSpendTiers((salonRow as { vip_spend_tiers?: unknown } | null)?.vip_spend_tiers);

  const spenders: TopSpender[] = rows.map((r) => {
    const phone = String(r.client_profiles!.phone);
    const totalSpendCents = Number(r.total_spend_cents ?? 0);
    return {
      phone,
      name: overrides.get(phone) || r.client_profiles?.name?.trim() || null,
      isVip: vipPhones.has(phone),
      totalSpendCents,
      paymentCount: Number(r.payment_count ?? 0),
      lastPaymentAt: r.last_payment_at?.trim() ? String(r.last_payment_at) : null,
      tier: spendTier(totalSpendCents, tiers),
    };
  });

  return { ok: true, spenders };
}
