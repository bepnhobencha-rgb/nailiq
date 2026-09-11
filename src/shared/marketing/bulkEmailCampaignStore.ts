import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  bulkEmailCampaignInputSchema,
  bulkEmailContentFingerprint,
  type BulkEmailCampaignInput,
} from "./bulkEmailCampaign";

export type BulkEmailCampaignStatus =
  | "draft"
  | "prepared"
  | "approved"
  | "sending"
  | "completed"
  | "cancelled";

export type BulkEmailCampaignSummary = {
  id: string;
  name: string;
  subject: string;
  status: BulkEmailCampaignStatus;
  audienceCount: number;
  excludedNoConsent: number;
  excludedInvalidEmail: number;
  excludedOptout: number;
  excludedProviderSuppression: number;
  excludedDuplicate: number;
  dispatchStage: "locked" | "canary" | "canary_complete" | "bulk" | "paused" | "completed";
  canarySize: number;
  canaryClaimedCount: number;
  batchSize: number;
  bulkReleaseApprovedAt: string | null;
  createdAt: string;
};

export type BulkEmailCampaignList = {
  available: boolean;
  campaigns: BulkEmailCampaignSummary[];
};

type RpcResult = {
  success?: boolean;
  code?: string;
  campaign_id?: string;
  audience_count?: number;
  canary_limit?: number;
  stage?: string;
};

function parseRpcResult(value: unknown): RpcResult {
  return value && typeof value === "object" ? (value as RpcResult) : {};
}

export async function createBulkEmailCampaignDraft(input: {
  salonId: string;
  actorUserId: string;
  campaign: BulkEmailCampaignInput;
}): Promise<{ ok: true; campaignId: string } | { ok: false; code: string }> {
  const campaign = bulkEmailCampaignInputSchema.parse(input.campaign);
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc("create_marketing_email_campaign_draft" as never, {
    p_salon_id: input.salonId,
    p_actor_user_id: input.actorUserId,
    p_name: campaign.name,
    p_subject: campaign.subject,
    p_preheader: campaign.preheader,
    p_headline: campaign.headline,
    p_body: campaign.body,
    p_image_url: campaign.imageUrl || null,
    p_cta_label: campaign.ctaLabel,
    p_cta_url: campaign.ctaUrl,
    p_content_fingerprint: bulkEmailContentFingerprint(campaign),
    p_canary_size: campaign.canarySize,
    p_batch_size: campaign.batchSize,
    p_send_after: campaign.sendAfter || null,
  } as never);
  if (error) return { ok: false, code: "storage_unavailable" };
  const result = parseRpcResult(data);
  return result.success && typeof result.campaign_id === "string"
    ? { ok: true, campaignId: result.campaign_id }
    : { ok: false, code: result.code ?? "draft_failed" };
}

export async function prepareBulkEmailCampaign(input: {
  campaignId: string;
  actorUserId: string;
}): Promise<{ ok: boolean; code: string; audienceCount?: number }> {
  const { data, error } = await createServiceRoleClient().rpc(
    "prepare_marketing_email_campaign" as never,
    { p_campaign_id: input.campaignId, p_actor_user_id: input.actorUserId } as never,
  );
  if (error) return { ok: false, code: "storage_unavailable" };
  const result = parseRpcResult(data);
  return {
    ok: result.success === true,
    code: result.code ?? "prepare_failed",
    ...(typeof result.audience_count === "number" ? { audienceCount: result.audience_count } : {}),
  };
}

export async function approveBulkEmailCampaign(input: {
  campaignId: string;
  actorUserId: string;
}): Promise<{ ok: boolean; code: string }> {
  const { data, error } = await createServiceRoleClient().rpc(
    "approve_marketing_email_campaign" as never,
    { p_campaign_id: input.campaignId, p_actor_user_id: input.actorUserId } as never,
  );
  if (error) return { ok: false, code: "storage_unavailable" };
  const result = parseRpcResult(data);
  return { ok: result.success === true, code: result.code ?? "approve_failed" };
}

async function runControlledCampaignRpc(
  functionName:
    | "start_marketing_email_campaign_canary"
    | "pause_marketing_email_campaign_dispatch"
    | "resume_marketing_email_campaign_dispatch"
    | "approve_marketing_email_campaign_bulk_release",
  input: { campaignId: string; actorUserId: string },
): Promise<{ ok: boolean; code: string; canaryLimit?: number; stage?: string }> {
  const { data, error } = await createServiceRoleClient().rpc(functionName as never, {
    p_campaign_id: input.campaignId,
    p_actor_user_id: input.actorUserId,
  } as never);
  if (error) return { ok: false, code: "storage_unavailable" };
  const result = parseRpcResult(data);
  return {
    ok: result.success === true,
    code: result.code ?? "control_failed",
    ...(typeof result.canary_limit === "number" ? { canaryLimit: result.canary_limit } : {}),
    ...(typeof result.stage === "string" ? { stage: result.stage } : {}),
  };
}

export function startBulkEmailCampaignCanary(input: { campaignId: string; actorUserId: string }) {
  return runControlledCampaignRpc("start_marketing_email_campaign_canary", input);
}

export function pauseBulkEmailCampaignDispatch(input: { campaignId: string; actorUserId: string }) {
  return runControlledCampaignRpc("pause_marketing_email_campaign_dispatch", input);
}

export function resumeBulkEmailCampaignDispatch(input: { campaignId: string; actorUserId: string }) {
  return runControlledCampaignRpc("resume_marketing_email_campaign_dispatch", input);
}

export function approveBulkEmailCampaignRelease(input: { campaignId: string; actorUserId: string }) {
  return runControlledCampaignRpc("approve_marketing_email_campaign_bulk_release", input);
}

export async function loadBulkEmailCampaigns(salonId: string): Promise<BulkEmailCampaignList> {
  try {
    const { data, error } = await createServiceRoleClient()
      .from("marketing_email_campaigns" as never)
      .select("id,name,subject,status,audience_count,excluded_no_consent,excluded_invalid_email,excluded_optout,excluded_provider_suppression,excluded_duplicate,dispatch_stage,canary_size,canary_claimed_count,batch_size,bulk_release_approved_at,created_at")
      .eq("salon_id" as never, salonId)
      .order("created_at" as never, { ascending: false })
      .limit(12);
    if (error) return { available: false, campaigns: [] };
    return {
      available: true,
      campaigns: ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        subject: String(row.subject),
        status: row.status as BulkEmailCampaignStatus,
        audienceCount: Number(row.audience_count ?? 0),
        excludedNoConsent: Number(row.excluded_no_consent ?? 0),
        excludedInvalidEmail: Number(row.excluded_invalid_email ?? 0),
        excludedOptout: Number(row.excluded_optout ?? 0),
        excludedProviderSuppression: Number(row.excluded_provider_suppression ?? 0),
        excludedDuplicate: Number(row.excluded_duplicate ?? 0),
        dispatchStage: String(row.dispatch_stage ?? "locked") as BulkEmailCampaignSummary["dispatchStage"],
        canarySize: Number(row.canary_size ?? 25),
        canaryClaimedCount: Number(row.canary_claimed_count ?? 0),
        batchSize: Number(row.batch_size ?? 100),
        bulkReleaseApprovedAt: row.bulk_release_approved_at ? String(row.bulk_release_approved_at) : null,
        createdAt: String(row.created_at),
      })),
    };
  } catch {
    return { available: false, campaigns: [] };
  }
}
