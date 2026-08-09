"use server";

import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import { writeAuditLog } from "@/shared/superadmin/audit";
import { loadReleaseReviewById } from "@/shared/superadmin/releaseReviewStore";
import type { ReleaseReviewDecision } from "@/shared/superadmin/releaseReviewTypes";

const ALLOWED_ROLES = new Set(["founder", "ops_admin"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function requireReviewer(): Promise<{
  userId: string;
  role: string;
} | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const role = await getSuperAdminRole(user.id);
  if (!role || !ALLOWED_ROLES.has(role)) return null;
  return { userId: user.id, role };
}

export async function confirmReleaseReviewDecision(
  reviewId: string,
  decision: ReleaseReviewDecision,
): Promise<never> {
  const caller = await requireReviewer();
  if (!caller) notFound();
  if (!UUID_RE.test(reviewId) || !["approved", "declined"].includes(decision)) {
    notFound();
  }

  const review = await loadReleaseReviewById(reviewId);
  if (!review) notFound();

  if (review.status === "pending") {
    const audited = await writeAuditLog({
      actorUserId: caller.userId,
      actorRole: caller.role,
      action:
        decision === "approved"
          ? "release_review_approved"
          : "release_review_declined",
      targetKind: "release_review",
      targetId: review.id,
      beforeJsonb: {
        deployment_id: review.deploymentId,
        status: review.status,
      },
      afterJsonb: { status: decision },
    });
    if (!audited) {
      redirect(
        `/superadmin/operations/release-reviews/${review.id}?intent=${decision}&error=audit`,
      );
    }

    const db = createServiceRoleClient();
    const updated = (await db
      .from("platform_release_reviews" as never)
      .update(
        {
          status: decision,
          decision_by: caller.userId,
          decided_at: new Date().toISOString(),
        } as never,
      )
      .eq("id" as never, review.id)
      .eq("status" as never, "pending")
      .select("id" as never)
      .maybeSingle()) as { data: { id: string } | null; error: unknown };
    if (updated.error) {
      console.error("[release-review] decision", updated.error);
      redirect(
        `/superadmin/operations/release-reviews/${review.id}?intent=${decision}&error=save`,
      );
    }
    if (!updated.data) {
      const current = await loadReleaseReviewById(review.id);
      revalidatePath("/superadmin", "layout");
      if (current?.status === "approved") {
        redirect(
          `/superadmin/operations/announcements?release=${encodeURIComponent(current.deploymentId)}`,
        );
      }
      redirect(
        `/superadmin/operations/release-reviews/${review.id}?intent=declined&done=1`,
      );
    }
  }

  revalidatePath("/superadmin", "layout");
  if (decision === "approved") {
    redirect(
      `/superadmin/operations/announcements?release=${encodeURIComponent(review.deploymentId)}`,
    );
  }
  redirect(
    `/superadmin/operations/release-reviews/${review.id}?intent=declined&done=1`,
  );
}
