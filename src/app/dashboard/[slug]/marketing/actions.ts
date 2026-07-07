"use server";

import { revalidatePath } from "next/cache";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { runReoptinBatch, type BatchSummary } from "@/shared/reoptin/reoptinCampaign";

type ActionResult =
  | { ok: true; summary: BatchSummary; sentTo?: string }
  | { ok: false; error: string };

/**
 * Send one sample re-opt-in email to the logged-in owner/admin for copy review.
 * No DB writes, no voucher — just renders + sends the real template.
 */
export async function sendReoptinTestAction(slug: string): Promise<ActionResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "unauthorized" };

  const {
    data: { user },
  } = await ctx.supabase.auth.getUser();
  const email = user?.email;
  if (!email) return { ok: false, error: "no_email" };

  const summary = await runReoptinBatch(slug, { testTo: email });
  return { ok: true, summary, sentTo: email };
}

/**
 * Send the re-opt-in campaign to the next `limit` eligible customers (highest
 * spend first, never anyone already sent). Owner/admin only — the batch runs
 * with a service-role client, so this auth check is the only guard.
 */
export async function sendReoptinCampaignAction(
  slug: string,
  limit: number,
): Promise<ActionResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "unauthorized" };

  const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 0), 5000));
  const summary = await runReoptinBatch(slug, { limit: safeLimit });
  revalidatePath(`/dashboard/${slug}/marketing`);
  return { ok: true, summary };
}
