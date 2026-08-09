import { NextResponse } from "next/server";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";
import { currentReleaseReviewContext } from "@/shared/superadmin/releaseReviewContext";
import { ensureReleaseReviewEmail } from "@/shared/superadmin/releaseReviewEmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorizationError = requireCronAuthorization(request);
  if (authorizationError) return authorizationError;

  return runTrackedCron("release_review", async () => {
    const release = currentReleaseReviewContext();
    if (!release) {
      return NextResponse.json({ ok: true, state: "no_production_release" });
    }

    const result = await ensureReleaseReviewEmail(release);
    return NextResponse.json(result, { status: result.ok ? 200 : 503 });
  });
}
