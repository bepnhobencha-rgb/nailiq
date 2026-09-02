import { describe, expect, it } from "vitest";

import {
  isOfflineCommandAllowed,
  turnIqOfflineCommandSchema,
} from "@/shared/turniq/offlineContracts";

describe("TurnIQ offline contracts", () => {
  it("keeps provider, notification and policy mutations outside the command union", () => {
    const base = {
      schemaVersion: 1,
      commandId: "00000000-0000-4000-8000-000000000001",
      salonId: "00000000-0000-4000-8000-000000000002",
      deviceId: "00000000-0000-4000-8000-000000000003",
      deviceGeneration: 1,
      policyVersionId: "00000000-0000-4000-8000-000000000004",
      localSequence: 1,
      expectedStateVersion: 0,
      actorUserId: "00000000-0000-4000-8000-000000000005",
      clientTimestamp: "2026-09-02T18:00:00.000Z",
      snapshotFingerprint: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
    };
    for (const type of ["send_sms", "send_email", "charge_card", "change_policy"]) {
      expect(turnIqOfflineCommandSchema.safeParse({ ...base, body: { type } }).success).toBe(false);
    }
  });

  it("requires a reason for an approved break and assignment override", () => {
    expect(
      isOfflineCommandAllowed({
        type: "shift",
        staffId: "00000000-0000-4000-8000-000000000006",
        action: "break",
      }),
    ).toBe(false);
    expect(
      isOfflineCommandAllowed({
        type: "assignment",
        assignmentId: "00000000-0000-4000-8000-000000000007",
        action: "override",
        assignedStaffId: "00000000-0000-4000-8000-000000000006",
        reason: "Customer changed technician in person",
      }),
    ).toBe(true);
  });

  it("fails closed when an offline service update contains multiple add-ons", () => {
    const parsed = turnIqOfflineCommandSchema.safeParse({
      schemaVersion: 1,
      commandId: "00000000-0000-4000-8000-000000000001",
      salonId: "00000000-0000-4000-8000-000000000002",
      deviceId: "00000000-0000-4000-8000-000000000003",
      deviceGeneration: 1,
      policyVersionId: "00000000-0000-4000-8000-000000000004",
      localSequence: 1,
      expectedStateVersion: 0,
      actorUserId: "00000000-0000-4000-8000-000000000005",
      clientTimestamp: "2026-09-02T18:00:00.000Z",
      snapshotFingerprint: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      body: {
        type: "service_update",
        assignmentId: "00000000-0000-4000-8000-000000000006",
        serviceId: "00000000-0000-4000-8000-000000000007",
        addonServiceIds: [
          "00000000-0000-4000-8000-000000000008",
          "00000000-0000-4000-8000-000000000009",
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });
});
