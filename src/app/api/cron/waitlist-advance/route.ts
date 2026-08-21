/**
 * Expires stale waitlist claim links and notifies the next person in line.
 * Called every 5 minutes by Vercel Cron.
 *
 * The canonical DB transition expires stale claim capabilities, advances FIFO,
 * and returns the exact next action-scoped offer for durable delivery.
 */
import { NextRequest, NextResponse } from "next/server";
import { advanceAndDeliverWaitlistOffers } from "@/shared/noshow/promoteAndDeliverWaitlistOffer";
import { refundRefilledLateCancels } from "@/shared/integrations/square/noshow";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minutes a claim link stays live before the next person is notified. */
const CLAIM_WINDOW_MINUTES = 20;

export async function GET(req: NextRequest) {
  const authorizationError = requireCronAuthorization(req);
  if (authorizationError) return authorizationError;
  return runTrackedCron("waitlist_advance", async () => {

  const advancedResult = await advanceAndDeliverWaitlistOffers(CLAIM_WINDOW_MINUTES);
  if (!advancedResult.ok) {
    console.error("[waitlist-advance] canonical advancement failed", advancedResult.code);
    return NextResponse.json({ error: "rpc_failed" }, { status: 500 });
  }

  // Fair Cancel: refund late-cancel fees whose freed slot has since been
  // rebooked (best-effort; never fails the waitlist advance).
  let refunded = 0;
  try {
    const r = await refundRefilledLateCancels();
    refunded = r.refunded;
  } catch (e) {
    console.error("[waitlist-advance] late-cancel refund pass failed", e);
  }

    return NextResponse.json({ ok: true, advanced: advancedResult.advanced, refunded });
  });
}
