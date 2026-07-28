import "server-only";

import { NextResponse } from "next/server";

import {
  recordAiWorkerHeartbeat,
  type CronWorkerName,
} from "@/shared/ai/executionHeartbeat";

/**
 * Run authorized cron work inside the fenced, append-only scheduler ledger.
 *
 * Callers must authenticate before entering this wrapper. If the start cannot
 * be persisted, the handler is never invoked. Terminal persistence failures
 * return an honest error and leave the run visibly stale instead of claiming
 * success without an operating record.
 */
export async function runTrackedCron(
  workerName: CronWorkerName,
  handler: () => Promise<Response>,
): Promise<Response> {
  const runId = crypto.randomUUID();

  try {
    await recordAiWorkerHeartbeat({
      workerName,
      runId,
      phase: "started",
      now: new Date(),
      summary: { source: "vercel_cron" },
    });
  } catch (error) {
    console.error(`[cron/${workerName}] heartbeat start`, error);
    return NextResponse.json(
      { ok: false, error: "cron_heartbeat_unavailable" },
      { status: 500 },
    );
  }

  let response: Response;
  try {
    response = await handler();
  } catch (error) {
    try {
      await recordAiWorkerHeartbeat({
        workerName,
        runId,
        phase: "failed",
        now: new Date(),
        summary: { outcome: "handler_exception" },
        error: "handler_exception",
      });
    } catch (heartbeatError) {
      console.error(
        `[cron/${workerName}] heartbeat failure`,
        heartbeatError,
      );
    }
    throw error;
  }

  const phase = response.ok ? "succeeded" : "failed";
  const errorCode = response.ok ? null : `http_${response.status}`;
  try {
    await recordAiWorkerHeartbeat({
      workerName,
      runId,
      phase,
      now: new Date(),
      summary: { http_status: response.status },
      error: errorCode,
    });
  } catch (error) {
    console.error(`[cron/${workerName}] heartbeat completion`, error);
    return NextResponse.json(
      { ok: false, error: "cron_heartbeat_unavailable" },
      { status: 500 },
    );
  }

  return response;
}
