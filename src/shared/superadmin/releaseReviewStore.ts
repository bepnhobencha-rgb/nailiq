import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type { ReleaseReviewContext } from "@/shared/superadmin/releaseReviewContext";
import {
  isReleaseReviewStatus,
  type PlatformReleaseReview,
} from "@/shared/superadmin/releaseReviewTypes";

type ReviewRow = {
  id: string;
  deployment_id: string;
  change_summary: string;
  status: string;
  email_sent_at: string | null;
  decided_at: string | null;
};

function mapReview(row: ReviewRow): PlatformReleaseReview | null {
  if (!isReleaseReviewStatus(row.status)) return null;
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    changeSummary: row.change_summary,
    status: row.status,
    emailSentAt: row.email_sent_at,
    decidedAt: row.decided_at,
  };
}

const SELECT_COLUMNS =
  "id, deployment_id, change_summary, status, email_sent_at, decided_at";

export async function loadReleaseReviewById(
  id: string,
): Promise<PlatformReleaseReview | null> {
  const db = createServiceRoleClient();
  const result = (await db
    .from("platform_release_reviews" as never)
    .select(SELECT_COLUMNS as never)
    .eq("id" as never, id)
    .maybeSingle()) as { data: ReviewRow | null; error: unknown };
  if (result.error || !result.data) return null;
  return mapReview(result.data);
}

export async function loadReleaseReviewByDeployment(
  deploymentId: string,
): Promise<PlatformReleaseReview | null> {
  const db = createServiceRoleClient();
  const result = (await db
    .from("platform_release_reviews" as never)
    .select(SELECT_COLUMNS as never)
    .eq("deployment_id" as never, deploymentId)
    .maybeSingle()) as { data: ReviewRow | null; error: unknown };
  if (result.error || !result.data) return null;
  return mapReview(result.data);
}

/**
 * Keep the Superadmin notice compatible during rollout: before the additive
 * table exists (or before the first cron claim), the original local review
 * still appears. Once a durable decision exists, it disappears everywhere.
 */
export async function resolveReleaseReviewNotice(
  context: ReleaseReviewContext | null,
): Promise<ReleaseReviewContext | null> {
  if (!context) return null;
  try {
    const review = await loadReleaseReviewByDeployment(context.deploymentId);
    if (!review) return context;
    if (review.status !== "pending") return null;
    return { ...context, reviewId: review.id };
  } catch (error) {
    console.error("[release-review] notice fallback", error);
    return context;
  }
}
