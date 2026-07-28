import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { toMinhLogEntry } from "@/shared/ai/loadMinhActivity";
import { deriveOutcomeMeasurement } from "@/shared/ai/outcomeMeasurement";

describe("deriveOutcomeMeasurement", () => {
  it("excludes pending actions from the observed return-rate denominator", () => {
    expect(
      deriveOutcomeMeasurement([
        "converted",
        "no_conversion",
        null,
        null,
      ]),
    ).toEqual({
      sent: 4,
      measured: 2,
      pending: 2,
      converted: 1,
      noConversion: 1,
      observedReturnPct: 50,
      coveragePct: 50,
    });
  });

  it("does not report a return rate before any measurement window concludes", () => {
    expect(deriveOutcomeMeasurement([null, null])).toEqual({
      sent: 2,
      measured: 0,
      pending: 2,
      converted: 0,
      noConversion: 0,
      observedReturnPct: null,
      coveragePct: 0,
    });
  });

  it("handles an empty activity window without inventing effectiveness", () => {
    expect(deriveOutcomeMeasurement([])).toEqual({
      sent: 0,
      measured: 0,
      pending: 0,
      converted: 0,
      noConversion: 0,
      observedReturnPct: null,
      coveragePct: 0,
    });
  });
});

describe("AI activity presentation", () => {
  it("shows a committed operational note as an execution activity", () => {
    expect(
      toMinhLogEntry({
        id: "activity-1",
        agent: "ai_execution",
        action_type: "approved_operational_note",
        payload: {
          execution_job_id: "job-1",
          approval_request_id: "approval-1",
          note: "Review tomorrow's staffing gap",
        },
        created_at: "2026-07-28T04:30:00.000Z",
        outcome: null,
        outcome_at: null,
      }),
    ).toMatchObject({
      agentIcon: "⚙️",
      agentLabel: "Thực thi",
      actionType: "approved_operational_note",
      messagePreview: "Review tomorrow's staffing gap",
      trackable: false,
    });
  });
});
