import "server-only";

import { isAiAgentPermissionEnabled } from "@/shared/ai/agentPermissionFence";
import {
  deterministicReactivationCampaignDraft,
  reactivationCampaignPeriodKey,
  type ReactivationCampaignKind,
} from "@/shared/ai/reactivationCampaignPolicy";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export async function createReactivationCampaignDraft(input: {
  salonId: string;
  salonName: string;
  kind: ReactivationCampaignKind;
  todayYmd?: string;
}): Promise<"created" | "existing" | "in_progress" | "disabled" | "failed"> {
  const flag = input.kind === "winback" ? "ai_winback" : "ai_rebook";
  if (!(await isAiAgentPermissionEnabled(input.salonId, flag))) {
    return "disabled";
  }

  const today = input.todayYmd ?? new Date().toISOString().slice(0, 10);
  const periodKey = reactivationCampaignPeriodKey(today);
  if (!periodKey) return "failed";
  const draft = deterministicReactivationCampaignDraft(input);
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "create_reactivation_campaign_draft" as never,
    {
      p_salon_id: input.salonId,
      p_campaign_kind: input.kind,
      p_period_key: periodKey,
      p_title: draft.title,
      p_message_en: draft.messageEn,
      p_message_vi: draft.messageVi,
    } as never,
  );
  if (error) return "failed";
  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: unknown }
    | null;
  return row?.outcome === "created" ||
    row?.outcome === "existing" ||
    row?.outcome === "in_progress"
    ? row.outcome
    : "failed";
}
