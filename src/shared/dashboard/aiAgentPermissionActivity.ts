import {
  AI_AGENT_DISPLAY_NAME,
  AI_AGENT_IMPACT_LABEL,
  isAiAgentFlagKey,
  type AiAgentImpact,
} from "@/shared/dashboard/aiAgentTypes";
import type { ActivityItem } from "@/shared/dashboard/loadActivityFeedAction";

type PermissionAuditRow = {
  id?: unknown;
  flag_key?: unknown;
  impact?: unknown;
  enabled?: unknown;
  previous_enabled?: unknown;
  impact_acknowledged?: unknown;
  actor_role?: unknown;
  actor_kind?: unknown;
  created_at?: unknown;
};

const ACTOR_LABEL: Record<string, string> = {
  owner: "Chủ tiệm",
  admin: "Quản lý",
  demo_cookie: "Demo",
};

const str = (value: unknown): string =>
  value == null ? "" : String(value);

export function aiAgentPermissionActivityItem(
  row: PermissionAuditRow,
  actorName?: string | null,
): ActivityItem {
  const flagKey = isAiAgentFlagKey(row.flag_key)
    ? row.flag_key
    : null;
  const impact = str(row.impact) as AiAgentImpact;
  const enabled = row.enabled === true;
  const actorRole = str(row.actor_role);
  const actor =
    actorName?.trim() ||
    ACTOR_LABEL[actorRole] ||
    ACTOR_LABEL[str(row.actor_kind)] ||
    "Hệ thống";
  const agentName = flagKey
    ? AI_AGENT_DISPLAY_NAME[flagKey]
    : str(row.flag_key) || "AI agent";
  const impactLabel =
    AI_AGENT_IMPACT_LABEL[impact] || `Phạm vi: ${impact || "không xác định"}`;
  const acknowledgement = row.impact_acknowledged === true
    ? "Đã xác nhận tác động trước khi bật."
    : enabled
      ? "Không yêu cầu xác nhận riêng cho phạm vi này."
      : "Tắt quyền không cần xác nhận tác động.";

  return {
    id: `ap-${str(row.id)}`,
    kind: "ai",
    when: str(row.created_at),
    title: `${actor} đã ${enabled ? "bật" : "tắt"} ${agentName}`,
    subtitle: impactLabel,
    status: null,
    actorRole: actorRole || null,
    bookingId: null,
    bookingDate: null,
    transcript: [
      `AI agent: ${agentName}`,
      `Thay đổi: ${row.previous_enabled === true ? "Bật" : "Tắt"} → ${enabled ? "Bật" : "Tắt"}`,
      `Tác động: ${impactLabel}`,
      acknowledgement,
    ].join("\n"),
  };
}
