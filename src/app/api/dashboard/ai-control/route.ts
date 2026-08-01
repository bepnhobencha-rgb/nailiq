import { type NextRequest, NextResponse } from "next/server";

import { controlExecutionJobAction } from "@/shared/ai/controlExecutionJobAction";
import { controlOperationalExceptionAction } from "@/shared/ai/controlOperationalExceptionAction";
import { decideApprovalAction } from "@/shared/ai/decideApprovalAction";
import { preflightCampaignAction } from "@/shared/ai/preflightCampaignAction";
import { prepareAudienceAction } from "@/shared/ai/prepareAudienceAction";
import { sealCampaignPlanAction } from "@/shared/ai/sealCampaignPlanAction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

function id(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

function resultStatus(result: { ok: boolean; error?: string }): number {
  if (result.ok) return 200;
  if (result.error === "unauthorized") return 401;
  if (result.error === "forbidden") return 403;
  if (result.error === "not_found") return 404;
  if (result.error === "server_error") return 500;
  if (
    result.error === "expired" ||
    result.error === "already_decided" ||
    result.error === "invalid_state"
  ) {
    return 409;
  }
  return 422;
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return json({ ok: false, error: "invalid_origin" }, 403);
  }

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  const slug =
    typeof body?.slug === "string" && body.slug.length <= 120
      ? body.slug.trim()
      : "";
  const action = typeof body?.action === "string" ? body.action : "";
  if (!slug || !action) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }

  let result: { ok: boolean; error?: string; [key: string]: unknown };
  if (action === "decide_approval") {
    const approvalId = id(body?.approvalId);
    const decision = body?.decision;
    if (
      !approvalId ||
      (decision !== "approved" && decision !== "declined")
    ) {
      return json({ ok: false, error: "invalid_request" }, 400);
    }
    result = await decideApprovalAction({ slug, approvalId, decision });
  } else if (action === "control_exception") {
    const alertId = id(body?.alertId);
    const operation = body?.operation;
    const resolutionNote = body?.resolutionNote;
    if (
      !alertId ||
      !["acknowledge", "resolve", "reopen"].includes(String(operation)) ||
      (resolutionNote !== undefined && typeof resolutionNote !== "string")
    ) {
      return json({ ok: false, error: "invalid_request" }, 400);
    }
    result = await controlOperationalExceptionAction({
      slug,
      alertId,
      operation: operation as "acknowledge" | "resolve" | "reopen",
      resolutionNote,
    });
  } else if (action === "control_job") {
    const jobId = id(body?.jobId);
    const operation = body?.operation;
    if (!jobId || (operation !== "retry" && operation !== "cancel")) {
      return json({ ok: false, error: "invalid_request" }, 400);
    }
    result = await controlExecutionJobAction({ slug, jobId, operation });
  } else if (
    action === "prepare_audience" ||
    action === "preflight_campaign" ||
    action === "seal_campaign"
  ) {
    const jobId = id(body?.jobId);
    if (!jobId) {
      return json({ ok: false, error: "invalid_request" }, 400);
    }
    result =
      action === "prepare_audience"
        ? await prepareAudienceAction({ slug, jobId })
        : action === "preflight_campaign"
          ? await preflightCampaignAction({ slug, jobId })
          : await sealCampaignPlanAction({ slug, jobId });
  } else {
    return json({ ok: false, error: "invalid_request" }, 400);
  }

  return json(result, resultStatus(result));
}
