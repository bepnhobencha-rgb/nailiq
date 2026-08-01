import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type StrategistOperationalNoteApprovalResult =
  | { status: "no_candidate" }
  | {
      status: "created" | "existing";
      approvalRequestId: string;
      sourceActionId: string;
    };

type RpcResult = {
  status?: unknown;
  approval_request_id?: unknown;
  source_action_id?: unknown;
};

export async function surfaceStrategistOperationalNoteApproval(
  salonId: string,
  now: Date,
): Promise<StrategistOperationalNoteApprovalResult> {
  if (!salonId || Number.isNaN(now.getTime())) {
    throw new Error("invalid_strategist_operational_note_input");
  }

  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "surface_strategist_operational_note_approval" as never,
    {
      p_salon_id: salonId,
      p_now: now.toISOString(),
    } as never,
  );
  if (error) throw new Error(error.message);

  const result = data as RpcResult | null;
  if (result?.status === "no_candidate") {
    return { status: "no_candidate" };
  }
  if (
    (result?.status === "created" || result?.status === "existing") &&
    typeof result.approval_request_id === "string" &&
    typeof result.source_action_id === "string"
  ) {
    return {
      status: result.status,
      approvalRequestId: result.approval_request_id,
      sourceActionId: result.source_action_id,
    };
  }

  throw new Error("invalid_strategist_operational_note_result");
}
