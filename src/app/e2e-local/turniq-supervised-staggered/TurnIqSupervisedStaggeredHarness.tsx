"use client";

import { useRef } from "react";

import { TurnIqGroupPlanCard } from "@/components/receptionist/TurnIqGroupPlanCard";
import type {
  TurnIqGroupPlanView,
  TurnIqGroupQueueView,
  TurnIqGroupTimingComparisonView,
} from "@/shared/turniq/groupReadModels";

const IDS = {
  group: "11111111-1111-4111-8111-111111111111",
  plan: "22222222-2222-4222-8222-222222222222",
  bookingA: "33333333-3333-4333-8333-333333333331",
  bookingB: "33333333-3333-4333-8333-333333333332",
  assignmentA: "44444444-4444-4444-8444-444444444441",
  assignmentB: "44444444-4444-4444-8444-444444444442",
  staffA: "55555555-5555-4555-8555-555555555551",
  staffB: "55555555-5555-4555-8555-555555555552",
  service: "66666666-6666-4666-8666-666666666666",
  resourceA: "77777777-7777-4777-8777-777777777771",
  resourceB: "77777777-7777-4777-8777-777777777772",
  simulationStart: "88888888-8888-4888-8888-888888888881",
  simulationFinish: "88888888-8888-4888-8888-888888888882",
  simulationWave: "88888888-8888-4888-8888-888888888883",
  receiptA: "99999999-9999-4999-8999-999999999991",
  receiptB: "99999999-9999-4999-8999-999999999992",
} as const;

const queue: TurnIqGroupQueueView = {
  businessDate: "2026-09-02",
  groups: [
    {
      bookingGroupId: IDS.group,
      partySize: 2,
      requestedStartAt: "2026-09-02T18:00:00.000Z",
      serviceSummary: "Classic Pedicure",
      readiness: "ready",
      existingPlanId: null,
      existingPlanStatus: null,
    },
  ],
};

const comparison: TurnIqGroupTimingComparisonView = {
  bookingGroupId: IDS.group,
  snapshotVersion: "synthetic-m4i-snapshot-v1",
  comparedAt: "2026-09-02T17:59:00.000Z",
  windowMinutes: 240,
  finishOffsetMinutes: 120,
  liveStateChanged: false,
  options: [
    {
      simulationId: IDS.simulationStart,
      simulationFingerprint: "1".repeat(64),
      intent: "start_together",
      feasible: false,
      liveStateChanged: false,
      explanation: "No complete safe option was proven.",
      ownerActionRequired: true,
      eta: null,
      metrics: null,
      assignments: [],
    },
    {
      simulationId: IDS.simulationFinish,
      simulationFingerprint: "2".repeat(64),
      intent: "finish_together",
      feasible: true,
      liveStateChanged: false,
      explanation: "Both guests can leave together in a safe plan.",
      ownerActionRequired: false,
      eta: {
        earliestStartMinutes: 0,
        allStartedByMinutes: 30,
        confidencePaddingMinutes: 10,
      },
      metrics: {
        waveCount: 2,
        maximumWaitMinutes: 30,
        totalWaitMinutes: 30,
        latestReleaseMinutes: 90,
      },
      assignments: [
        {
          taskId: IDS.bookingA,
          staff: { id: IDS.staffA, name: "Mai" },
          serviceSummary: "Classic Pedicure",
          resourceNames: ["Chair 1"],
          startsAt: "2026-09-02T18:30:00.000Z",
          releasesAt: "2026-09-02T19:30:00.000Z",
          waitMinutes: 30,
          waveNumber: 2,
        },
        {
          taskId: IDS.bookingB,
          staff: { id: IDS.staffB, name: "Linh" },
          serviceSummary: "Classic Pedicure",
          resourceNames: ["Chair 2"],
          startsAt: "2026-09-02T18:30:00.000Z",
          releasesAt: "2026-09-02T19:30:00.000Z",
          waitMinutes: 30,
          waveNumber: 2,
        },
      ],
    },
    {
      simulationId: IDS.simulationWave,
      simulationFingerprint: "3".repeat(64),
      intent: "smart_wave",
      feasible: true,
      liveStateChanged: false,
      explanation: "Two safe waves minimize the proven wait.",
      ownerActionRequired: false,
      eta: {
        earliestStartMinutes: 0,
        allStartedByMinutes: 15,
        confidencePaddingMinutes: 10,
      },
      metrics: {
        waveCount: 2,
        maximumWaitMinutes: 15,
        totalWaitMinutes: 15,
        latestReleaseMinutes: 75,
      },
      assignments: [
        {
          taskId: IDS.bookingA,
          staff: { id: IDS.staffA, name: "Mai" },
          serviceSummary: "Classic Pedicure",
          resourceNames: ["Chair 1"],
          startsAt: "2026-09-02T18:00:00.000Z",
          releasesAt: "2026-09-02T19:00:00.000Z",
          waitMinutes: 0,
          waveNumber: 1,
        },
        {
          taskId: IDS.bookingB,
          staff: { id: IDS.staffB, name: "Linh" },
          serviceSummary: "Classic Pedicure",
          resourceNames: ["Chair 2"],
          startsAt: "2026-09-02T18:15:00.000Z",
          releasesAt: "2026-09-02T19:15:00.000Z",
          waitMinutes: 15,
          waveNumber: 2,
        },
      ],
    },
  ],
};

function plan(confirmed: boolean): TurnIqGroupPlanView {
  return {
    id: IDS.plan,
    bookingGroupId: IDS.group,
    partySize: 2,
    requestedStartAt: "2026-09-02T18:00:00.000Z",
    decisionTimestamp: "2026-09-02T17:59:30.000Z",
    status: confirmed ? "confirmed" : "recommended",
    stateVersion: confirmed ? 2 : 1,
    planningMode: "staggered",
    timingIntent: "smart_wave",
    explanation: "Two safe waves minimize the proven wait.",
    eta: {
      earliestStartMinutes: 0,
      allStartedByMinutes: 15,
      confidencePaddingMinutes: 10,
    },
    ownerActionRequired: false,
    canConfirm: !confirmed,
    fairnessReceiptCount: confirmed ? 2 : 0,
    assignments: [
      {
        assignmentId: IDS.assignmentA,
        bookingId: IDS.bookingA,
        staff: { id: IDS.staffA, name: "Mai" },
        service: { id: IDS.service, name: "Classic Pedicure" },
        resource: { id: IDS.resourceA, name: "Chair 1" },
        startsAt: "2026-09-02T18:00:00.000Z",
        safeEndAt: "2026-09-02T19:00:00.000Z",
        waitMinutes: 0,
        requestedFallback: false,
        status: confirmed ? "confirmed" : "recommended",
        fairnessReceiptId: confirmed ? IDS.receiptA : null,
        waveNumber: 1,
      },
      {
        assignmentId: IDS.assignmentB,
        bookingId: IDS.bookingB,
        staff: { id: IDS.staffB, name: "Linh" },
        service: { id: IDS.service, name: "Classic Pedicure" },
        resource: { id: IDS.resourceB, name: "Chair 2" },
        startsAt: "2026-09-02T18:15:00.000Z",
        safeEndAt: "2026-09-02T19:15:00.000Z",
        waitMinutes: 15,
        requestedFallback: false,
        status: confirmed ? "confirmed" : "recommended",
        fairnessReceiptId: confirmed ? IDS.receiptB : null,
        waveNumber: 2,
      },
    ],
  };
}

export type TurnIqM4iScenario = "happy" | "stale" | "refresh_failure" | "offline";

export function TurnIqSupervisedStaggeredHarness({
  scenario,
}: {
  scenario: TurnIqM4iScenario;
}) {
  const confirmedRef = useRef(false);
  const failReadBackOnceRef = useRef(scenario === "refresh_failure");

  return (
    <main className="min-h-screen bg-nq-bg p-4 text-nq-text sm:p-8">
      <div className="mx-auto max-w-4xl">
        <p className="mb-4 text-sm font-semibold text-nq-muted">
          Synthetic TurnIQ M4I local · no database or provider calls
        </p>
        <TurnIqGroupPlanCard
          queue={queue}
          errorCode={null}
          language="vi"
          timezone="America/Vancouver"
          slug="e2e-turniq-m4i"
          canManage
          offline={scenario === "offline"}
          onCompareTiming={async () => ({ ok: true, data: comparison })}
          onRecordTimingPlan={async (input) =>
            scenario === "stale"
              ? { ok: false, code: "stale_state" }
              : {
                  ok: true,
                  result: {
                    commandId: input.commandId,
                    replayed: false,
                    groupPlanId: IDS.plan,
                    bookingGroupId: IDS.group,
                    partySize: 2,
                    status: "recommended",
                    stateVersion: 1,
                    fairnessReceiptIds: [],
                  },
                }
          }
          onConfirmStaggered={async (input) => {
            confirmedRef.current = true;
            return {
              ok: true,
              result: {
                commandId: input.commandId,
                replayed: false,
                groupPlanId: IDS.plan,
                bookingGroupId: IDS.group,
                partySize: 2,
                status: "confirmed",
                stateVersion: 2,
                fairnessReceiptIds: [IDS.receiptA, IDS.receiptB],
              },
            };
          }}
          onRecommend={async () => ({ ok: false, code: "stale_state" })}
          onConfirm={async () => ({ ok: false, code: "stale_state" })}
          onLoadPlan={async () => {
            if (failReadBackOnceRef.current) {
              failReadBackOnceRef.current = false;
              throw new Error("synthetic read-back failure");
            }
            return { ok: true, data: plan(confirmedRef.current) };
          }}
          onRefresh={async () => undefined}
        />
      </div>
    </main>
  );
}
