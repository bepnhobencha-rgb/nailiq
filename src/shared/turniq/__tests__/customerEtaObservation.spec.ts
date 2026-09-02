import { describe, expect, it } from "vitest";

import { projectTurnIqCustomerEta } from "@/shared/turniq/customerEta";
import { createTurnIqCustomerEtaObservation } from "@/shared/turniq/customerEtaObservation";

const projection = projectTurnIqCustomerEta({
  snapshotVersion: "synthetic-m4l-v1",
  snapshotCapturedAt: "2026-09-02T18:00:00.000Z",
  nowIso: "2026-09-02T18:00:00.000Z",
  status: "waiting",
  partySize: 1,
  conservativeEta: {
    earliestStartMinutes: 10,
    allStartedByMinutes: 10,
    confidencePaddingMinutes: 10,
  },
  freshness: "fresh",
});

describe("TurnIQ M4L ETA accuracy observation", () => {
  it("creates stable privacy-safe telemetry for a start inside the range", async () => {
    const result = await createTurnIqCustomerEtaObservation({
      projection,
      observedStartAt: "2026-09-02T18:15:00.000Z",
    });
    expect(result).toMatchObject({
      outcome: "within_range",
      deviationMinutes: 0,
      predictedWidthMinutes: 10,
    });
    expect(result.estimateFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.observationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(
      /booking|customer|staff|salon|revenue|tip|queue/i,
    );
  });

  it("distinguishes late starts without exposing an exact peer cause", async () => {
    const result = await createTurnIqCustomerEtaObservation({
      projection,
      observedStartAt: "2026-09-02T18:27:00.000Z",
    });
    expect(result).toMatchObject({ outcome: "late", deviationMinutes: 7 });
  });

  it("rejects an observation when no ETA range existed", async () => {
    const completed = projectTurnIqCustomerEta({
      snapshotVersion: "synthetic-m4l-complete",
      snapshotCapturedAt: "2026-09-02T18:00:00.000Z",
      nowIso: "2026-09-02T19:00:00.000Z",
      status: "completed",
      partySize: 1,
      conservativeEta: null,
      freshness: "fresh",
    });
    await expect(createTurnIqCustomerEtaObservation({
      projection: completed,
      observedStartAt: "2026-09-02T18:15:00.000Z",
    })).rejects.toThrow("turniq_eta_range_not_observable");
  });
});
