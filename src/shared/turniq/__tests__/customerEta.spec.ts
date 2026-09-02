import { describe, expect, it } from "vitest";

import {
  fingerprintTurnIqCustomerEta,
  measureTurnIqCustomerEtaAccuracy,
  projectTurnIqCustomerEta,
  TurnIqCustomerEtaError,
  type TurnIqCustomerEtaInput,
} from "@/shared/turniq/customerEta";

const BASE: TurnIqCustomerEtaInput = {
  snapshotVersion: "salon-a-snapshot-42",
  snapshotCapturedAt: "2026-09-02T17:00:00.000Z",
  nowIso: "2026-09-02T17:02:00.000Z",
  status: "waiting",
  partySize: 1,
  conservativeEta: {
    earliestStartMinutes: 12,
    allStartedByMinutes: 12,
    confidencePaddingMinutes: 8,
  },
  freshness: "fresh",
};

describe("TurnIQ M4J conservative customer ETA", () => {
  it("rounds outward to a range instead of promising an exact minute", () => {
    const result = projectTurnIqCustomerEta(BASE);
    expect(result.surface).toBe("waiting");
    expect(result.waitRange).toEqual({ earliestMinutes: 10, latestMinutes: 20 });
    expect(result.message.vi).toContain("10–20 phút");
    expect(result.reasonCodes).toEqual([
      "ETA_FRESH_PLAN",
      "ETA_CONSERVATIVE_PADDING_APPLIED",
    ]);
  });

  it("keeps even a ready-soon estimate non-exact", () => {
    const result = projectTurnIqCustomerEta({
      ...BASE,
      nowIso: "2026-09-02T17:11:30.000Z",
      maxSnapshotAgeMinutes: 15,
    });
    expect(result.waitRange).toEqual({ earliestMinutes: 0, latestMinutes: 10 });
  });

  it("adds a separate whole-party start range without internal turn order", () => {
    const result = projectTurnIqCustomerEta({
      ...BASE,
      partySize: 4,
      conservativeEta: {
        earliestStartMinutes: 0,
        allStartedByMinutes: 25,
        confidencePaddingMinutes: 10,
      },
      memberStartMinutes: 10,
    });
    expect(result.waitRange).toEqual({ earliestMinutes: 5, latestMinutes: 20 });
    expect(result.partyFullyStartedRange).toEqual({
      earliestMinutes: 20,
      latestMinutes: 35,
    });
    expect(result.reasonCodes).toContain("ETA_PARTY_RANGE_INCLUDED");
    expect(JSON.stringify(result)).not.toMatch(/staff|revenue|tip|fairness|queuePosition/i);
  });

  it("labels a recent offline estimate as last known", () => {
    const result = projectTurnIqCustomerEta({
      ...BASE,
      freshness: "offline_last_known",
    });
    expect(result.surface).toBe("last_known");
    expect(result.stale).toBe(false);
    expect(result.reasonCodes).toContain("ETA_LAST_KNOWN_OFFLINE");
    expect(result.message.vi).toContain("Kết nối đang yếu");
  });

  it("fails closed once the snapshot is stale", () => {
    const result = projectTurnIqCustomerEta({
      ...BASE,
      nowIso: "2026-09-02T17:05:00.001Z",
    });
    expect(result.surface).toBe("updating");
    expect(result.stale).toBe(true);
    expect(result.waitRange).toBeNull();
    expect(result.reasonCodes).toEqual(["ETA_SNAPSHOT_STALE"]);
  });

  it("does not invent an ETA when a plan has no estimate", () => {
    const result = projectTurnIqCustomerEta({
      ...BASE,
      conservativeEta: null,
    });
    expect(result.surface).toBe("updating");
    expect(result.waitRange).toBeNull();
    expect(result.reasonCodes).toEqual(["ETA_INSUFFICIENT_DATA"]);
  });

  it.each([
    ["ready", "ready"],
    ["in_service", "in_service"],
  ] as const)("treats %s as authoritative without an estimate", (status, surface) => {
    const result = projectTurnIqCustomerEta({
      ...BASE,
      status,
      conservativeEta: null,
      nowIso: "2026-09-02T17:04:00.000Z",
    });
    expect(result.surface).toBe(surface);
    expect(result.waitRange).toBeNull();
    expect(result.reasonCodes).toEqual(["ETA_STATUS_AUTHORITATIVE"]);
  });

  it.each([
    ["completed", "completed"],
    ["cancelled", "cancelled"],
  ] as const)("keeps terminal %s authoritative after the estimate expires", (status, surface) => {
    const result = projectTurnIqCustomerEta({
      ...BASE,
      status,
      conservativeEta: null,
      nowIso: "2026-09-02T19:00:00.000Z",
    });
    expect(result.surface).toBe(surface);
    expect(result.waitRange).toBeNull();
    expect(result.reasonCodes).toEqual(["ETA_STATUS_AUTHORITATIVE"]);
  });

  it("does not present a stale transient status as current", () => {
    const result = projectTurnIqCustomerEta({
      ...BASE,
      status: "ready",
      conservativeEta: null,
      nowIso: "2026-09-02T17:06:00.000Z",
    });
    expect(result.surface).toBe("updating");
    expect(result.reasonCodes).toEqual(["ETA_SNAPSHOT_STALE"]);
  });

  it("is deterministic and produces a stable privacy-safe fingerprint", async () => {
    const first = projectTurnIqCustomerEta(BASE);
    const second = projectTurnIqCustomerEta({ ...BASE });
    expect(second).toEqual(first);
    const [left, right] = await Promise.all([
      fingerprintTurnIqCustomerEta(first),
      fingerprintTurnIqCustomerEta(second),
    ]);
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records ETA accuracy without customer or technician data", () => {
    const estimate = projectTurnIqCustomerEta(BASE);
    expect(
      measureTurnIqCustomerEtaAccuracy(
        estimate,
        "2026-09-02T17:16:00.000Z",
      ),
    ).toEqual({
      outcome: "within_range",
      deviationMinutes: 0,
      predictedWidthMinutes: 10,
    });
    expect(
      measureTurnIqCustomerEtaAccuracy(
        estimate,
        "2026-09-02T17:25:30.000Z",
      ),
    ).toEqual({
      outcome: "late",
      deviationMinutes: 4,
      predictedWidthMinutes: 10,
    });
  });

  it("rejects malformed or unsafe inputs", () => {
    const unsafe = [
      { ...BASE, partySize: 0 },
      { ...BASE, snapshotVersion: "" },
      { ...BASE, snapshotCapturedAt: "invalid" },
      {
        ...BASE,
        conservativeEta: {
          earliestStartMinutes: 20,
          allStartedByMinutes: 10,
          confidencePaddingMinutes: 5,
        },
      },
    ];
    for (const input of unsafe) {
      expect(() => projectTurnIqCustomerEta(input)).toThrow(TurnIqCustomerEtaError);
    }
  });

  it("rejects accuracy observations for non-estimate states", () => {
    const stale = projectTurnIqCustomerEta({
      ...BASE,
      nowIso: "2026-09-02T17:06:00.000Z",
    });
    expect(() =>
      measureTurnIqCustomerEtaAccuracy(
        stale,
        "2026-09-02T17:20:00.000Z",
      ),
    ).toThrowError("turniq_eta_range_not_observable");
  });

  it("keeps every generated customer range non-negative, ordered and non-exact", () => {
    for (let earliest = 0; earliest <= 60; earliest += 3) {
      for (let spread = 0; spread <= 30; spread += 5) {
        const result = projectTurnIqCustomerEta({
          ...BASE,
          nowIso: "2026-09-02T17:04:59.000Z",
          partySize: spread === 0 ? 1 : 3,
          conservativeEta: {
            earliestStartMinutes: earliest,
            allStartedByMinutes: earliest + spread,
            confidencePaddingMinutes: 7,
          },
        });
        expect(result.waitRange).not.toBeNull();
        expect(result.waitRange!.earliestMinutes).toBeGreaterThanOrEqual(0);
        expect(result.waitRange!.latestMinutes).toBeGreaterThan(
          result.waitRange!.earliestMinutes,
        );
        expect(result.waitRange!.earliestMinutes % 5).toBe(0);
        expect(result.waitRange!.latestMinutes % 5).toBe(0);
      }
    }
  });
});
