import { NextResponse } from "next/server";
import { processExecutionQueue } from "@/shared/ai/executionWorker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<NextResponse> {
  const cronSecret = (process.env.CRON_SECRET ?? "").trim();
  if (!cronSecret) {
    return NextResponse.json(
      { ok: false, error: "cron_secret_not_configured" },
      { status: 503 },
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  try {
    const summary = await processExecutionQueue({ limit: 10 });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error("[cron/ai-execution]", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "execution_failed",
      },
      { status: 500 },
    );
  }
}
