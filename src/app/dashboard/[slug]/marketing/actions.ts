"use server";

import { revalidatePath } from "next/cache";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { runReoptinBatch, type BatchSummary } from "@/shared/reoptin/reoptinCampaign";
import { scheduleCampaign, cancelSchedule } from "@/shared/reoptin/campaignSchedule";
import { salonWallTimeToUtcIso } from "@/shared/lib/salonTime";
import { bulkEmailCampaignInputSchema } from "@/shared/marketing/bulkEmailCampaign";
import {
  approveBulkEmailCampaign,
  createBulkEmailCampaignDraft,
  prepareBulkEmailCampaign,
} from "@/shared/marketing/bulkEmailCampaignStore";

type ActionResult =
  | { ok: true; summary: BatchSummary; sentTo?: string }
  | { ok: false; error: string };

type ScheduleResult =
  | { ok: true; scheduledAtIso: string }
  | { ok: false; error: string };

export type BulkCampaignActionResult =
  | { ok: true; code: string; campaignId?: string; audienceCount?: number }
  | { ok: false; code: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function bulkCampaignActor(slug: string) {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) return null;
  const { data: { user } } = await ctx.supabase.auth.getUser();
  return user ? { ctx, userId: user.id } : null;
}

export async function createBulkEmailCampaignAction(
  slug: string,
  values: unknown,
): Promise<BulkCampaignActionResult> {
  const actor = await bulkCampaignActor(slug);
  if (!actor) return { ok: false, code: "unauthorized" };
  const parsed = bulkEmailCampaignInputSchema.safeParse(values);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  let result: Awaited<ReturnType<typeof createBulkEmailCampaignDraft>>;
  try {
    result = await createBulkEmailCampaignDraft({
      salonId: actor.ctx.salon.id,
      actorUserId: actor.userId,
      campaign: parsed.data,
    });
  } catch {
    return { ok: false, code: "storage_unavailable" };
  }
  if (!result.ok) return result;
  revalidatePath(`/dashboard/${slug}/marketing`);
  return { ok: true, code: "draft_created", campaignId: result.campaignId };
}

export async function prepareBulkEmailCampaignAction(
  slug: string,
  campaignId: string,
): Promise<BulkCampaignActionResult> {
  const actor = await bulkCampaignActor(slug);
  if (!actor) return { ok: false, code: "unauthorized" };
  if (!UUID_RE.test(campaignId)) return { ok: false, code: "invalid_input" };
  let result: Awaited<ReturnType<typeof prepareBulkEmailCampaign>>;
  try {
    result = await prepareBulkEmailCampaign({ campaignId, actorUserId: actor.userId });
  } catch {
    return { ok: false, code: "storage_unavailable" };
  }
  if (!result.ok) return { ok: false, code: result.code };
  revalidatePath(`/dashboard/${slug}/marketing`);
  return { ok: true, code: result.code, audienceCount: result.audienceCount };
}

export async function approveBulkEmailCampaignAction(
  slug: string,
  campaignId: string,
): Promise<BulkCampaignActionResult> {
  const actor = await bulkCampaignActor(slug);
  if (!actor) return { ok: false, code: "unauthorized" };
  if (!UUID_RE.test(campaignId)) return { ok: false, code: "invalid_input" };
  let result: Awaited<ReturnType<typeof approveBulkEmailCampaign>>;
  try {
    result = await approveBulkEmailCampaign({ campaignId, actorUserId: actor.userId });
  } catch {
    return { ok: false, code: "storage_unavailable" };
  }
  if (!result.ok) return { ok: false, code: result.code };
  revalidatePath(`/dashboard/${slug}/marketing`);
  return { ok: true, code: result.code };
}

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
