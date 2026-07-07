"use server";

import { revalidatePath } from "next/cache";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { runReoptinBatch, type BatchSummary } from "@/shared/reoptin/reoptinCampaign";
import { scheduleCampaign, cancelSchedule } from "@/shared/reoptin/campaignSchedule";
import { salonWallTimeToUtcIso } from "@/shared/lib/salonTime";

type ActionResult =
  | { ok: true; summary: BatchSummary; sentTo?: string }
  | { ok: false; error: string };

type ScheduleResult =
  | { ok: true; scheduledAtIso: string }
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

/**
 * Queue the campaign for a salon-local date + hour. The hour is interpreted in
 * the salon's timezone and converted to a UTC instant server-side (never trust a
 * browser tz). A cron fires it when due.
 */
export async function scheduleReoptinCampaignAction(
  slug: string,
  limit: number,
  dateYmd: string,
  hour: number,
): Promise<ScheduleResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "unauthorized" };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) return { ok: false, error: "invalid_date" };
  const h = Math.max(0, Math.min(23, Math.floor(Number(hour) || 0)));

  const { data: salon } = await ctx.supabase
    .from("salons")
    .select("timezone")
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const tz = (salon as { timezone?: string } | null)?.timezone || "America/Los_Angeles";
  const scheduledAtIso = salonWallTimeToUtcIso(dateYmd, h * 60, tz);

  const {
    data: { user },
  } = await ctx.supabase.auth.getUser();

  const res = await scheduleCampaign({
    salonId: ctx.salon.id,
    sendLimit: Math.max(1, Math.min(Math.floor(Number(limit) || 0), 5000)),
    scheduledAtIso,
    createdBy: user?.id ?? null,
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath(`/dashboard/${slug}/marketing`);
  return { ok: true, scheduledAtIso };
}

export async function cancelScheduleAction(
  slug: string,
  id: string,
): Promise<{ ok: boolean }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false };
  await cancelSchedule(ctx.salon.id, id);
  revalidatePath(`/dashboard/${slug}/marketing`);
  return { ok: true };
}
