/**
 * Auto-retry failed no-show fee charges — turns "declined / no funds" into
 * recovered revenue with zero staff effort. The card may have funds on a later
 * day, so we re-attempt the charge.
 *
 * Cadence (Huy's choice): once per day, at most 3 attempts per booking, only
 * within RETRY_WINDOW_DAYS of the appointment, then it's left for the desk.
 * Runs daily via Vercel Cron. A retry uses a fresh idempotency suffix so Square
 * actually re-charges instead of replaying the original decline.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { chargeNoShowFee } from "@/shared/integrations/square/noshow";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 55;

const MAX_ATTEMPTS = 3;
const RETRY_WINDOW_DAYS = 7;

export async function GET(req: NextRequest) {
  const authorizationError = requireCronAuthorization(req);
  if (authorizationError) return authorizationError;
  return runTrackedCron("noshow_charge_retry", async () => {

  const supabase = createServiceRoleClient();
  const windowStart = new Date(
    Date.now() - RETRY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  // ~1/day pacing safety net (in case the cron fires more than once a day).
  const pacingCutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("bookings")
    .select("id, noshow_charge_attempts, noshow_last_charge_attempt_at")
    .eq("noshow_charge_status", "failed")
    .eq("status", "no_show")
    .not("noshow_card_id", "is", null)
    .lt("noshow_charge_attempts", MAX_ATTEMPTS)
    .gte("start_time_utc", windowStart)
    .limit(200);

  if (error) {
    console.error("[noshow-charge-retry] query failed", error);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const due = ((data ?? []) as Array<{
    id: string;
    noshow_charge_attempts: number | null;
    noshow_last_charge_attempt_at: string | null;
  }>).filter(
    (r) =>
      !r.noshow_last_charge_attempt_at ||
      r.noshow_last_charge_attempt_at < pacingCutoff,
  );

  let retried = 0;
  let charged = 0;
  for (const r of due) {
    const attempt = (r.noshow_charge_attempts ?? 0) + 1;
    retried += 1;
    try {
      // Ordinary replay never rotates the provider key. Unknown/pending rows
      // remain reconciliation-required until the ledger worker claims them.
      const res = await chargeNoShowFee(r.id);
      if (res.charged) charged += 1;
    } catch (e) {
      console.error("[noshow-charge-retry] charge threw", r.id, e);
    }
    // Always record the attempt (success flips status to 'charged' inside
    // chargeNoShowFee; a failure leaves 'failed' and the bumped count caps it).
    await supabase
      .from("bookings")
      .update({
        noshow_charge_attempts: attempt,
        noshow_last_charge_attempt_at: new Date().toISOString(),
      } as never)
      .eq("id", r.id);
  }

    return NextResponse.json({ ok: true, retried, charged, processedAt: new Date().toISOString() });
  });
}
