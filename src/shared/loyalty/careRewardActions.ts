"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

export type CareRewardKind = "birthday" | "milestone";

export type CareReward = {
  type: "none" | "percent" | "amount";
  /** Percent 1–100 when type=percent. */
  percent: number | null;
  /** Cents when type=amount. */
  amountCents: number | null;
  validDays: number;
};

/** Owner/admin: set an AI VIP Care reward (birthday or milestone gift). When
 *  type != 'none', that email attaches a real voucher for this reward. */
export async function updateCareReward(
  slug: string,
  kind: CareRewardKind,
  input: CareReward,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) return { ok: false, error: "unauthorized" };

  const type = input.type;
  if (type !== "none" && type !== "percent" && type !== "amount") {
    return { ok: false, error: "invalid_type" };
  }

  let percent: number | null = null;
  let amountCents: number | null = null;
  if (type === "percent") {
    percent = Math.round(Number(input.percent));
    if (!(percent > 0 && percent <= 100)) return { ok: false, error: "percent must be 1–100" };
  } else if (type === "amount") {
    amountCents = Math.round(Number(input.amountCents));
    if (!(amountCents > 0)) return { ok: false, error: "amount must be > 0" };
  }
  const validDays = Math.round(Number(input.validDays));
  if (!(validDays >= 1 && validDays <= 365)) return { ok: false, error: "valid days must be 1–365" };

  const p = kind === "birthday" ? "birthday" : "milestone"; // column prefix
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("salons" as never)
    .update({
      [`${p}_reward_type`]: type,
      [`${p}_reward_percent`]: percent,
      [`${p}_reward_amount_cents`]: amountCents,
      [`${p}_reward_valid_days`]: validDays,
    } as never)
    .eq("id", ctx.salon.id);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
