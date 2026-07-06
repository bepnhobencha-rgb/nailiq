"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

export type BirthdayReward = {
  type: "none" | "percent" | "amount";
  /** Percent 1–100 when type=percent. */
  percent: number | null;
  /** Cents when type=amount. */
  amountCents: number | null;
  validDays: number;
};

/** Owner/admin: set the AI VIP Care birthday gift. When type != 'none', the
 *  birthday email attaches a real voucher for this reward. */
export async function updateBirthdayReward(
  slug: string,
  input: BirthdayReward,
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

  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("salons" as never)
    .update({
      birthday_reward_type: type,
      birthday_reward_percent: percent,
      birthday_reward_amount_cents: amountCents,
      birthday_reward_valid_days: validDays,
    } as never)
    .eq("id", ctx.salon.id);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
