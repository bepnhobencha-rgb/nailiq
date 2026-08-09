import type { ChannelDecision } from "@/shared/lib/channelResolver";

type VipActionRow = {
  action_type: unknown;
  target_id: unknown;
  created_at: unknown;
};

/**
 * Build delivery dedupe keys. Milestones are one-time for the lifetime of the
 * customer/salon relationship; birthdays reset each UTC calendar year and an
 * inactive nudge resets after 30 days.
 */
export function buildVipActionDedupeKeys(
  rows: VipActionRow[],
  now = new Date(),
): Set<string> {
  const keys = new Set<string>();
  const yearStart = `${now.getUTCFullYear()}-01-01T00:00:00.000Z`;
  const thirtyAgo = new Date(now.getTime() - 30 * 864e5).toISOString();

  for (const row of rows) {
    const type = row.action_type == null ? "" : String(row.action_type);
    const targetId = row.target_id == null ? "" : String(row.target_id);
    const createdAt = row.created_at == null ? "" : String(row.created_at);
    if (!type || !targetId) continue;

    if (type.startsWith("milestone_")) {
      keys.add(`${type}:${targetId}`);
    } else if (type === "birthday" && createdAt >= yearStart) {
      keys.add(`birthday:${targetId}`);
    } else if (type === "vip_inactive" && createdAt >= thirtyAgo) {
      keys.add(`vip_inactive:${targetId}`);
    }
  }

  return keys;
}

/**
 * Remove email from a VIP Care delivery decision after a fail-closed
 * suppression check. SMS remains available when independently permitted.
 */
export function applyVipEmailSuppression(
  decision: ChannelDecision,
  suppressed: boolean,
): ChannelDecision {
  if (!suppressed || !decision.email) return decision;

  if (decision.sms) {
    return {
      ...decision,
      email: false,
      noChannel: false,
      reason: `${decision.reason}_email_suppressed`,
    };
  }

  return {
    sms: false,
    email: false,
    noChannel: true,
    reason: "email_suppressed",
  };
}
