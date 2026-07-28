import { NextResponse } from "next/server";
import { recordExecutionWorkerHeartbeat } from "@/shared/ai/executionHeartbeat";
import { processExecutionQueue } from "@/shared/ai/executionWorker";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<NextResponse> {
  const authorizationError = requireCronAuthorization(req);
  if (authorizationError) return authorizationError;

  const runId = crypto.randomUUID();
  try {
    await recordExecutionWorkerHeartbeat({
      runId,
      phase: "started",
      now: new Date(),
    });
    const summary = await processExecutionQueue({ limit: 10 });
    await recordExecutionWorkerHeartbeat({
      runId,
      phase: "succeeded",
      now: new Date(),
      summary: {
        inspected: summary.inspected,
        recovered: summary.recovered,
        tenant_canceled: summary.tenantCanceled,
        claimed: summary.claimed,
        succeeded: summary.succeeded,
        failed: summary.failed,
        waiting_input: summary.waitingInput,
        canceled: summary.canceled,
      },
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error("[cron/ai-execution]", error);
    try {
      await recordExecutionWorkerHeartbeat({
        runId,
        phase: "failed",
        now: new Date(),
        error: error instanceof Error ? error.message : "execution_failed",
      });
    } catch (heartbeatError) {
      console.error("[cron/ai-execution] heartbeat failure", heartbeatError);
    }
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "execution_failed",
      },
      { status: 500 },
    );
  }
}
