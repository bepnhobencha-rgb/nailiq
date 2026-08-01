export type StrategistProposalInput = {
  type: "flash_deal" | "message_tweak";
  title: string;
  reasoning: string;
  draftMessage: string;
  coldSlots: Array<{ dayName: string; hour: number; count: number }>;
  totalBookings: number;
  returningClients: number;
  newClients: number;
};

export type StrategistApprovalProposal = {
  actionType: "bulk_message";
  summary: string;
  payload: Record<string, unknown>;
};

/**
 * One outstanding proposal PER ACTION TYPE, not one per salon.
 *
 * The strategist writes two unrelated kinds of approval request:
 * `record_operational_note` (via the surface_strategist_operational_note_approval
 * RPC) and `bulk_message` (via buildStrategistApprovalProposal). Matching on
 * `proposal_source` alone let a pending note starve campaign proposals
 * indefinitely — on 2026-07-31 all three production salons had sat blocked
 * behind a pending note since 2026-07-28.
 *
 * The owner still never sees two pending proposals of the same kind.
 */
export function hasPendingStrategistProposalOfType(
  requests: Array<{
    action_type: string;
    payload?: Record<string, unknown> | null;
  }>,
  criteria: { actionType: string; proposalSource: string },
): boolean {
  return requests.some(
    (request) =>
      request.action_type === criteria.actionType &&
      request.payload?.proposal_source === criteria.proposalSource,
  );
}

export function buildStrategistApprovalProposal(
  input: StrategistProposalInput,
): StrategistApprovalProposal {
  const quietSlots = input.coldSlots.slice(0, 3);
  const evidence = [
    `${input.totalBookings} bookings were recorded in the last 4 weeks.`,
    ...quietSlots.map(
      (slot) =>
        `${slot.dayName} at ${slot.hour}:00 had ${slot.count} bookings in the analysis window.`,
    ),
    `${input.returningClients} returning clients and ${input.newClients} new clients were observed.`,
  ];

  return {
    actionType: "bulk_message",
    summary: `${input.title}: ${input.draftMessage}`,
    payload: {
      proposal_source: "weekly_strategist",
      proposal_type: input.type,
      title: input.title,
      message: input.draftMessage,
      reason: input.reasoning,
      evidence,
      expected_impact:
        input.type === "flash_deal"
          ? "Fill one or more quiet appointment windows without changing permanent pricing."
          : "Improve customer re-engagement with a targeted message.",
      confidence: quietSlots.length > 0 ? 0.75 : 0.6,
      reversible: false,
      recipient_selection_required: true,
    },
  };
}
