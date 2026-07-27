import { describe, expect, it } from "vitest";

import { buildStrategistApprovalProposal } from "@/shared/ai/strategistProposal";

describe("buildStrategistApprovalProposal", () => {
  it("creates an honest approval payload from measured salon data", () => {
    const proposal = buildStrategistApprovalProposal({
      type: "flash_deal",
      title: "Fill Tuesday afternoons",
      reasoning: "Tuesday afternoons are quieter than the salon's busiest slots.",
      draftMessage: "Tuesday only: book a gel manicure and receive 10% off.",
      coldSlots: [{ dayName: "Tuesday", hour: 14, count: 2 }],
      totalBookings: 267,
      returningClients: 34,
      newClients: 19,
    });

    expect(proposal.actionType).toBe("bulk_message");
    expect(proposal.summary).toContain("Fill Tuesday afternoons");
    expect(proposal.payload).toMatchObject({
      proposal_source: "weekly_strategist",
      proposal_type: "flash_deal",
      confidence: 0.75,
      reversible: false,
      recipient_selection_required: true,
    });
    expect(proposal.payload.evidence).toEqual(
      expect.arrayContaining([
        "267 bookings were recorded in the last 4 weeks.",
        "Tuesday at 14:00 had 2 bookings in the analysis window.",
      ]),
    );
  });

  it("uses lower confidence when no quiet-slot evidence exists", () => {
    const proposal = buildStrategistApprovalProposal({
      type: "message_tweak",
      title: "Reconnect with clients",
      reasoning: "Retention can improve.",
      draftMessage: "We would love to see you again.",
      coldSlots: [],
      totalBookings: 20,
      returningClients: 4,
      newClients: 8,
    });

    expect(proposal.payload.confidence).toBe(0.6);
    expect(proposal.payload.expected_impact).toContain("re-engagement");
  });
});
