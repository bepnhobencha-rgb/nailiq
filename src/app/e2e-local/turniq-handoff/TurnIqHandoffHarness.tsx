"use client";

import { useRef } from "react";

import { TurnIqHandoffCard } from "@/components/receptionist/TurnIqHandoffCard";
import type { TurnIqHandoffPlanView, TurnIqHandoffQueueView } from "@/shared/turniq/handoffReadModels";

const IDS = {
  booking: "11111111-1111-4111-8111-111111111111",
  plan: "22222222-2222-4222-8222-222222222222",
  performerA: "33333333-3333-4333-8333-333333333331",
  performerB: "33333333-3333-4333-8333-333333333332",
  assignmentA: "44444444-4444-4444-8444-444444444441",
  assignmentB: "44444444-4444-4444-8444-444444444442",
  receiptA: "55555555-5555-4555-8555-555555555551",
  receiptB: "55555555-5555-4555-8555-555555555552",
} as const;

const queue: TurnIqHandoffQueueView = {
  businessDate: "2026-09-03",
  bookings: [
    {
      bookingId: IDS.booking,
      segmentCount: 2,
      serviceSummary: "Manicure + Pedicure",
      startsAt: "2026-09-03T18:00:00.000Z",
      existingPlanId: null,
      existingPlanStatus: null,
      readiness: "ready",
    },
  ],
};

function view(statuses: Map<string, string>, confirmed: boolean): TurnIqHandoffPlanView {
  const rows = [
    { id: IDS.performerA, assignmentId: IDS.assignmentA, staff: "Mai", service: "Manicure", resource: "Chair 1" },
    { id: IDS.performerB, assignmentId: IDS.assignmentB, staff: "Linh", service: "Pedicure", resource: "Chair 1" },
  ];
  return {
    id: IDS.plan,
    bookingId: IDS.booking,
    status: confirmed ? "confirmed" : "recommended",
    stateVersion: confirmed ? 2 : 1,
    explanation: "Mai và Linh đều rảnh, đủ kỹ năng và an toàn trước lịch kế tiếp.",
    ownerActionRequired: false,
    canConfirm: !confirmed,
    fairnessReceiptCount: confirmed ? 2 : 0,
    performers: rows.map((row, index) => ({
      performerId: row.id,
      assignmentId: row.assignmentId,
      staff: { id: `staff-${index + 1}`, name: row.staff },
      status: statuses.get(row.id) ?? (confirmed ? "confirmed" : "recommended"),
      segmentCount: 1,
      fairnessReceiptId: confirmed ? (index === 0 ? IDS.receiptA : IDS.receiptB) : null,
      segments: [
        {
          segmentId: `segment-${index + 1}`,
          serviceName: row.service,
          resourceName: row.resource,
          startsAt: "2026-09-03T18:00:00.000Z",
          releasesAt: "2026-09-03T19:00:00.000Z",
          requestedFallback: false,
        },
      ],
    })),
  };
}

export function TurnIqHandoffHarness() {
  const confirmed = useRef(false);
  const statuses = useRef(new Map<string, string>());
  return (
    <main className="min-h-screen bg-nq-bg p-4 text-nq-text sm:p-8">
      <div className="mx-auto max-w-4xl">
        <p className="mb-4 text-sm font-semibold text-nq-muted">Synthetic TurnIQ M4T local · no database or provider calls</p>
        <TurnIqHandoffCard
          queue={queue}
          errorCode={null}
          language="vi"
          timezone="America/Vancouver"
          slug="e2e-turniq-handoff"
          canManage
          offline={false}
          onRecommend={async (input) => ({
            ok: true,
            result: {
              commandId: input.commandId,
              replayed: false,
              handoffPlanId: IDS.plan,
              bookingId: IDS.booking,
              status: "recommended",
              stateVersion: 1,
              performerIds: [IDS.performerA, IDS.performerB],
              fairnessReceiptIds: [],
            },
          })}
          onConfirm={async (input) => {
            confirmed.current = true;
            return {
              ok: true,
              result: {
                commandId: input.commandId,
                replayed: false,
                handoffPlanId: IDS.plan,
                bookingId: IDS.booking,
                status: "confirmed",
                stateVersion: 2,
                performerIds: [IDS.performerA, IDS.performerB],
                fairnessReceiptIds: [IDS.receiptA, IDS.receiptB],
              },
            };
          }}
          onPerformer={async (input) => {
            statuses.current.set(input.performerId, input.command === "start" ? "in_progress" : "completed");
            return {
              ok: true,
              result: {
                commandId: input.commandId,
                replayed: false,
                handoffPlanId: IDS.plan,
                bookingId: IDS.booking,
                status: statuses.current.get(input.performerId) as string,
                stateVersion: input.command === "start" ? 3 : 4,
                performerIds: [input.performerId],
                fairnessReceiptIds: [],
              },
            };
          }}
          onLoadPlan={async () => ({ ok: true, data: view(statuses.current, confirmed.current) })}
          onRefresh={async () => undefined}
        />
      </div>
    </main>
  );
}
