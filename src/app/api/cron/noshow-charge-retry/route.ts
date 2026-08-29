/**
 * V1 no-show finalizer.
 *
 * The legacy route name is retained so Vercel scheduling and the append-only
 * cron ledger do not need a second worker identity. In V1 this route never
 * charges or refunds a card. It commits due 60-second attendance decisions and
 * then runs only their durable post-commit operational effects.
 */
import { NextRequest, NextResponse } from "next/server";

import {
  finalizeDueNoShowDecisions,
  runNoShowDecisionEffects,
} from "@/shared/noshow/noShowSafetyBoundary";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 55;

export async function GET(req: NextRequest) {
  const authorizationError = requireCronAuthorization(req);
  if (authorizationError) return authorizationError;
  return runTrackedCron("noshow_charge_retry", async () => {
    const finalized = await finalizeDueNoShowDecisions({ limit: 50 });
    const committed = finalized.filter(
      (row) => row.ok && row.code === "decision_committed",
    ).length;
    const invalidated = finalized.filter((row) => !row.ok).length;
    const effects = await runNoShowDecisionEffects({ limit: 25 });
    const finalizerAvailable = !finalized.some(
      (row) => row.code === "finalize_unavailable",
    );
    const ok = finalizerAvailable && effects.available &&
      effects.failed === 0 && effects.unknown === 0;
    return NextResponse.json({
      ok,
      ...(!ok ? { code: "no_show_safety_incomplete" } : {}),
      mode: "v1_no_show_safety",
      moneyMovement: "blocked_v1",
      finalized: committed,
      invalidated,
      effects,
      processedAt: new Date().toISOString(),
    }, { status: ok ? 200 : 503 });
  });
}
