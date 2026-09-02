import { describe, expect, it } from "vitest";

import {
  createTurnIqCustomerCheckInReceipt,
  TurnIqCustomerCheckInError,
  type TurnIqCustomerCheckInInput,
} from "@/shared/turniq/customerCheckIn";

const INPUT: TurnIqCustomerCheckInInput = {
  commandId: "11111111-1111-4111-8111-111111111111",
  channel: "qr",
  visitKind: "booked",
  serviceId: "22222222-2222-4222-8222-222222222222",
  partySize: 1,
  submittedAt: "2026-09-02T18:00:00.000Z",
  actorSessionFingerprint: "a".repeat(64),
  requestedTechnician: null,
};

describe("TurnIQ M4L customer check-in receipt", () => {
  it("routes a booked single customer to deterministic engine review", async () => {
    const result = await createTurnIqCustomerCheckInReceipt(INPUT);
    expect(result).toMatchObject({
      shadowOnly: true,
      nextRoute: "single_engine_candidate",
      reasonCodes: [
        "CHECKIN_SHADOW_RECEIVED",
        "BOOKED_CAPABILITY_MATCH_REQUIRED",
        "SINGLE_ENGINE_CANDIDATE",
      ],
    });
    expect(result.intakeFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("routes a booked party to constrained group optimization", async () => {
    const result = await createTurnIqCustomerCheckInReceipt({ ...INPUT, partySize: 4 });
    expect(result.nextRoute).toBe("group_optimizer_required");
    expect(result.reasonCodes).toContain("GROUP_OPTIMIZER_REQUIRED");
  });

  it("preserves direct customer-request provenance without calling it staff-verified", async () => {
    const result = await createTurnIqCustomerCheckInReceipt({
      ...INPUT,
      channel: "kiosk",
      requestedTechnician: {
        staffId: "33333333-3333-4333-8333-333333333333",
        explicitlyConfirmed: true,
      },
    });
    expect(result.nextRoute).toBe("requested_tech_validation");
    expect(result.requestedTechnician).toMatchObject({
      source: "customer_selected",
      trustLabel: "customer_confirmed",
    });
    expect(result.requestedTechnician?.actorRef).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps a new walk-in at identity matching instead of silently creating a booking", async () => {
    const result = await createTurnIqCustomerCheckInReceipt({
      ...INPUT,
      visitKind: "walkin",
    });
    expect(result.nextRoute).toBe("identity_match_required");
    expect(result.message.en).toContain("No appointment has changed yet");
  });

  it("is deterministic for an idempotent command", async () => {
    const [first, second] = await Promise.all([
      createTurnIqCustomerCheckInReceipt(INPUT),
      createTurnIqCustomerCheckInReceipt({ ...INPUT }),
    ]);
    expect(second).toEqual(first);
  });

  it("rejects malformed public inputs before producing a receipt", async () => {
    const unsafe = [
      { ...INPUT, partySize: 0 },
      { ...INPUT, partySize: 13 },
      { ...INPUT, commandId: "not-a-uuid" },
      { ...INPUT, serviceId: "not-a-uuid" },
      { ...INPUT, actorSessionFingerprint: "raw-token" },
      { ...INPUT, submittedAt: "invalid" },
      { ...INPUT, channel: "public" },
      { ...INPUT, visitKind: "unknown" },
      {
        ...INPUT,
        requestedTechnician: {
          staffId: "33333333-3333-4333-8333-333333333333",
          explicitlyConfirmed: false,
        },
      },
    ];
    for (const value of unsafe) {
      await expect(createTurnIqCustomerCheckInReceipt(value as TurnIqCustomerCheckInInput))
        .rejects.toBeInstanceOf(TurnIqCustomerCheckInError);
    }
  });

  it("contains no PII, money, peer queue or exact ETA fields", async () => {
    const result = await createTurnIqCustomerCheckInReceipt(INPUT);
    expect(JSON.stringify(result)).not.toMatch(
      /name|phone|email|price|revenue|tip|queuePosition|waitMinutes|eta/i,
    );
  });
});
