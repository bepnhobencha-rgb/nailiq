import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { runReoptinBatch } from "@/shared/reoptin/reoptinCampaign";

/**
 * Scheduled campaign sends. An owner queues a campaign for a salon-local time;
 * the /api/cron/campaign-scheduler cron fires the due ones. The underlying send
 * (runReoptinBatch) is idempotent per (salon, client), so a retried/duplicated
 * run never double-sends — which also makes stale-processing recovery safe.
 */

export type CampaignSchedule = {
  id: string;
  campaign_type: string;
  send_limit: number;
  scheduled_at: string;
  status: string;
  last_summary: unknown;
  created_at: string;
};

export async function scheduleCampaign(opts: {
  salonId: string;
  campaignType?: string;
  sendLimit: number;
  scheduledAtIso: string;
  createdBy?: string | null;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (new Date(opts.scheduledAtIso).getTime() <= Date.now()) {
    return { ok: false, error: "past" };
  }
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("campaign_schedules" as never)
    .insert({
      salon_id: opts.salonId,
      campaign_type: opts.campaignType ?? "reoptin",
      send_limit: Math.max(1, Math.min(Math.floor(opts.sendLimit) || 0, 5000)),
      scheduled_at: opts.scheduledAtIso,
      created_by: opts.createdBy ?? null,
    } as never)
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: String(error?.message ?? "insert_failed") };
  return { ok: true, id: (data as { id: string }).id };
}

export async function cancelSchedule(salonId: string, id: string): Promise<{ ok: boolean }> {
  const db = createServiceRoleClient();
  // Only pending schedules can be canceled (never one that's already firing/sent).
  await db
    .from("campaign_schedules" as never)
    .update({ status: "canceled" } as never)
    .eq("id" as never, id)
    .eq("salon_id" as never, salonId)
    .eq("status" as never, "pending");
  return { ok: true };
}

export async function loadSchedules(salonId: string): Promise<CampaignSchedule[]> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("campaign_schedules" as never)
    .select("id, campaign_type, send_limit, scheduled_at, status, last_summary, created_at")
    .eq("salon_id" as never, salonId)
    .in("status" as never, ["pending", "processing", "sent", "failed"])
    .order("scheduled_at" as never, { ascending: true })
    .limit(50);
  return (data ?? []) as CampaignSchedule[];
}

/**
 * Cron entry: fire every schedule whose time has arrived. Recovers rows stuck in
 * 'processing' (a prior run that died) after 15 min — safe because the send is
 * idempotent. Claims each row atomically (pending -> processing) so overlapping
 * cron ticks can't both run the same schedule.
 */
export async function runDueCampaigns(): Promise<{ claimed: number; sent: number }> {
  const db = createServiceRoleClient();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const staleIso = new Date(now - 15 * 60 * 1000).toISOString();

  // Recover schedules stuck mid-run.
  await db
    .from("campaign_schedules" as never)
    .update({ status: "pending" } as never)
    .eq("status" as never, "processing")
    .lt("processed_at" as never, staleIso);

  const { data: due } = await db
    .from("campaign_schedules" as never)
    .select("id, salon_id, send_limit")
    .eq("status" as never, "pending")
    .lte("scheduled_at" as never, nowIso)
    .order("scheduled_at" as never, { ascending: true })
    .limit(10);

  let claimed = 0;
  let sent = 0;
  for (const row of (due ?? []) as { id: string; salon_id: string; send_limit: number }[]) {
    // Atomic claim — only the tick that flips pending->processing runs it.
    const { data: got } = await db
      .from("campaign_schedules" as never)
      .update({ status: "processing", processed_at: new Date().toISOString() } as never)
      .eq("id" as never, row.id)
      .eq("status" as never, "pending")
      .select("id");
    if (!got || (got as unknown[]).length === 0) continue;
    claimed++;

    const { data: salon } = await db
      .from("salons" as never)
      .select("slug")
      .eq("id" as never, row.salon_id)
      .maybeSingle();
    if (!salon) {
      await db
        .from("campaign_schedules" as never)
        .update({ status: "failed", last_summary: { error: "salon_not_found" } } as never)
        .eq("id" as never, row.id);
      continue;
    }

    try {
      const summary = await runReoptinBatch((salon as { slug: string }).slug, {
        limit: row.send_limit,
      });
      await db
        .from("campaign_schedules" as never)
        .update({
          status: "sent",
          last_summary: summary,
          processed_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, row.id);
      sent += summary.sent;
    } catch (e) {
      await db
        .from("campaign_schedules" as never)
        .update({ status: "failed", last_summary: { error: String(e) } } as never)
        .eq("id" as never, row.id);
    }
  }
  return { claimed, sent };
}
