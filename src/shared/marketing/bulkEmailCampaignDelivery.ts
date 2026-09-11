import "server-only";

import { createHash } from "node:crypto";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { listUnsubscribeHeaders } from "@/shared/lib/emailCompliance";
import { emailExperienceTags } from "@/shared/lib/emailExperienceRegistry";
import { renderBulkEmailCampaign } from "./bulkEmailCampaign";

export type DeliveryMode = "disabled" | "simulate" | "resend";
type BulkEmailRuntimeEnv = Record<string, string | undefined>;

type Claim = {
  recipient_id: string;
  attempt_token: string;
  idempotency_key: string;
};

type Material = {
  success: boolean;
  code: string;
  destination_email?: string;
  client_name?: string;
  salon_name?: string;
  salon_address?: string | null;
  salon_email?: string | null;
  subject?: string;
  preheader?: string;
  headline?: string;
  body?: string;
  image_url?: string | null;
  cta_label?: string;
  cta_url?: string;
};

export type BulkEmailBatchSummary = {
  mode: DeliveryMode;
  claimed: number;
  simulated: number;
  providerAccepted: number;
  suppressed: number;
  failed: number;
  unknown: number;
};

export function bulkEmailDeliveryMode(env: BulkEmailRuntimeEnv = process.env): DeliveryMode {
  if (env.BULK_EMAIL_CAMPAIGN_DISPATCH_ENABLED !== "true") return "disabled";
  if (env.VERCEL_ENV === "production" && env.BULK_EMAIL_CAMPAIGN_PROVIDER === "resend") {
    return "resend";
  }
  if (
    env.VERCEL_ENV !== "production"
    && env.BULK_EMAIL_CAMPAIGN_PROVIDER === "mock"
    && env.BULK_EMAIL_CAMPAIGN_QA_SIMULATION_ENABLED === "true"
  ) {
    return "simulate";
  }
  return "disabled";
}

function validMaterial(value: unknown): Material | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Material;
  if (row.success !== true) return row;
  const required = [
    row.destination_email,
    row.client_name,
    row.salon_name,
    row.subject,
    row.headline,
    row.body,
    row.cta_label,
    row.cta_url,
  ];
  return required.every((item) => typeof item === "string" && item.length > 0) ? row : null;
}

function emptySummary(mode: DeliveryMode): BulkEmailBatchSummary {
  return { mode, claimed: 0, simulated: 0, providerAccepted: 0, suppressed: 0, failed: 0, unknown: 0 };
}

async function complete(
  recipientId: string,
  attemptToken: string,
  outcome: "simulated" | "provider_accepted" | "failed_pre_acceptance" | "unknown",
  providerMessageFingerprint?: string,
): Promise<boolean> {
  const { data, error } = await createServiceRoleClient().rpc(
    "complete_marketing_email_campaign_recipient" as never,
    {
      p_recipient_id: recipientId,
      p_attempt_token: attemptToken,
      p_outcome: outcome,
      p_provider_message_fingerprint: providerMessageFingerprint ?? null,
    } as never,
  );
  return !error && Boolean(data && typeof data === "object" && (data as { success?: boolean }).success === true);
}

/**
 * Deliberately has no route or cron callsite in this change. A later production
 * rollout must wire an authenticated worker and explicitly enable all DB and
 * environment gates. Preview can only exercise the durable flow in simulation.
 */
export async function runBulkEmailCampaignBatch(
  campaignId: string,
  requestedBatchSize = 25,
  env: BulkEmailRuntimeEnv = process.env,
): Promise<BulkEmailBatchSummary> {
  const mode = bulkEmailDeliveryMode(env);
  const summary = emptySummary(mode);
  if (mode === "disabled") return summary;

  const db = createServiceRoleClient();
  const { data: claimData, error: claimError } = await db.rpc(
    "claim_marketing_email_campaign_recipients" as never,
    {
      p_campaign_id: campaignId,
      p_batch_size: Math.max(1, Math.min(Math.floor(requestedBatchSize), 100)),
    } as never,
  );
  if (claimError) return summary;
  const claims = Array.isArray(claimData) ? (claimData as Claim[]) : [];
  summary.claimed = claims.length;

  for (const claim of claims) {
    const { data: materialData, error: materialError } = await db.rpc(
      "load_marketing_email_campaign_delivery_material" as never,
      { p_recipient_id: claim.recipient_id, p_attempt_token: claim.attempt_token } as never,
    );
    if (materialError) {
      await complete(claim.recipient_id, claim.attempt_token, "failed_pre_acceptance");
      summary.failed += 1;
      continue;
    }
    const material = validMaterial(materialData);
    if (material?.success === false && material.code === "suppressed") {
      summary.suppressed += 1;
      continue;
    }
    if (!material || material.success !== true) {
      await complete(claim.recipient_id, claim.attempt_token, "failed_pre_acceptance");
      summary.failed += 1;
      continue;
    }

    if (mode === "simulate") {
      const recorded = await complete(claim.recipient_id, claim.attempt_token, "simulated");
      if (recorded) summary.simulated += 1;
      else summary.failed += 1;
      continue;
    }

    const rendered = renderBulkEmailCampaign({
      subject: material.subject!,
      preheader: material.preheader ?? "",
      headline: material.headline!,
      body: material.body!,
      imageUrl: material.image_url ?? "",
      ctaLabel: material.cta_label!,
      ctaUrl: material.cta_url!,
      clientName: material.client_name!,
      clientEmail: material.destination_email!,
      salonName: material.salon_name!,
      salonAddress: material.salon_address,
    });

    try {
      const resend = getResendClient();
      if (!resend) {
        await complete(claim.recipient_id, claim.attempt_token, "failed_pre_acceptance");
        summary.failed += 1;
        continue;
      }
      const { data, error } = await resend.emails.send({
        from: getResendFrom(),
        to: material.destination_email!,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(material.salon_email ? { replyTo: material.salon_email } : {}),
        headers: listUnsubscribeHeaders(material.destination_email!),
        tags: emailExperienceTags("bulk_marketing_campaign"),
      }, { idempotencyKey: claim.idempotency_key });
      if (error || !data?.id) {
        const outcome = error ? "failed_pre_acceptance" : "unknown";
        await complete(claim.recipient_id, claim.attempt_token, outcome);
        if (outcome === "unknown") summary.unknown += 1;
        else summary.failed += 1;
        continue;
      }
      const receiptFingerprint = createHash("sha256").update(data.id, "utf8").digest("hex");
      const recorded = await complete(claim.recipient_id, claim.attempt_token, "provider_accepted", receiptFingerprint);
      if (recorded) summary.providerAccepted += 1;
      else summary.unknown += 1;
    } catch {
      await complete(claim.recipient_id, claim.attempt_token, "unknown");
      summary.unknown += 1;
    }
  }

  return summary;
}
