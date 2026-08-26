export type AiControlApiRequest =
  | {
      action: "decide_approval";
      approvalId: string;
      decision: "approved" | "declined";
    }
  | {
      action: "save_review_reply_draft";
      approvalId: string;
      draftReply: string;
    }
  | {
      action: "save_promo_campaign_draft";
      approvalId: string;
      draftMessage: string;
      offerFactsConfirmed: boolean;
    }
  | {
      action: "save_reactivation_campaign_draft";
      approvalId: string;
      messageEn: string;
      messageVi: string;
    }
  | {
      action: "control_exception";
      alertId: string;
      operation: "acknowledge" | "resolve" | "reopen";
      resolutionNote?: string;
    }
  | {
      action: "control_job";
      jobId: string;
      operation: "retry" | "cancel";
    }
  | {
      action: "prepare_audience" | "preflight_campaign" | "seal_campaign";
      jobId: string;
    };

export type AiControlApiResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string };

export async function postAiControl(
  slug: string,
  request: AiControlApiRequest,
): Promise<AiControlApiResult> {
  try {
    const response = await fetch("/api/dashboard/ai-control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, ...request }),
    });
    const result = (await response.json()) as AiControlApiResult;
    if (
      typeof result !== "object" ||
      result === null ||
      typeof result.ok !== "boolean"
    ) {
      return { ok: false, error: "server_error" };
    }
    return result;
  } catch {
    return { ok: false, error: "network_error" };
  }
}
