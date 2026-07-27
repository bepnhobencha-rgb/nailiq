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
