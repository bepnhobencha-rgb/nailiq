/**
 * VIP spend tiers from lifetime Square spend. Pure + shared by the server
 * (compute) and any UI (labels). Thresholds are per-salon configurable
 * (salons.vip_spend_tiers); NULL falls back to these defaults.
 */
export type VipTier = "gold" | "silver" | "bronze" | null;

export type VipSpendTiers = { gold: number; silver: number; bronze: number };

/** Defaults in cents: Gold $1000, Silver $500, Bronze $200. */
export const DEFAULT_VIP_SPEND_TIERS: VipSpendTiers = {
  gold: 100_000,
  silver: 50_000,
  bronze: 20_000,
};

/** Parse a salon's `vip_spend_tiers` jsonb into a clamped, ordered config. */
export function parseVipSpendTiers(raw: unknown): VipSpendTiers {
  const r = (raw ?? {}) as Partial<Record<keyof VipSpendTiers, unknown>>;
  const n = (v: unknown, def: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.round(x) : def;
  };
  const gold = n(r.gold, DEFAULT_VIP_SPEND_TIERS.gold);
  const silver = n(r.silver, DEFAULT_VIP_SPEND_TIERS.silver);
  const bronze = n(r.bronze, DEFAULT_VIP_SPEND_TIERS.bronze);
  // Keep gold ≥ silver ≥ bronze so the tiers don't overlap.
  return {
    gold: Math.max(gold, silver, bronze),
    silver: Math.min(Math.max(silver, bronze), gold),
    bronze: Math.min(bronze, silver, gold),
  };
}

/** The tier a lifetime spend earns (highest threshold met), or null. */
export function spendTier(cents: number, tiers: VipSpendTiers): VipTier {
  if (cents >= tiers.gold) return "gold";
  if (cents >= tiers.silver) return "silver";
  if (cents >= tiers.bronze) return "bronze";
  return null;
}

/** Bilingual label + emoji for a tier (for badges). */
export function vipTierLabel(tier: VipTier, lang: "en" | "vi"): string | null {
  if (!tier) return null;
  const map: Record<Exclude<VipTier, null>, [string, string]> = {
    gold: ["🥇 Gold", "🥇 Vàng"],
    silver: ["🥈 Silver", "🥈 Bạc"],
    bronze: ["🥉 Bronze", "🥉 Đồng"],
  };
  const [en, vi] = map[tier];
  return lang === "vi" ? vi : en;
}
