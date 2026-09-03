"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CloudOff, ReceiptText, Scale, ShieldCheck, Users } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { PwaRegister } from "@/components/layout/PwaRegister";
import type { TurnIqDecisionRecord } from "@/shared/turniq/contracts";
import { salonAGroupInputFixture, salonASingleCustomerInputFixture, salonATurnPolicyFixture } from "@/shared/turniq/fixtures/salonA";
import { decideTurnIqGroup } from "@/shared/turniq/groupMatchingEngine";
import { buildTurnIqOfflineCommand, TURNIQ_OFFLINE_SCHEMA_VERSION, type TurnIqOfflineSnapshot } from "@/shared/turniq/offlineContracts";
import { TurnIqOfflineStore } from "@/shared/turniq/offlineStore";
import { decideSingleCustomer } from "@/shared/turniq/singleCustomerEngine";
import { runTurnIqReplay, type TurnIqReplayResult } from "@/shared/turniq/shadowReplay";
import type { TurnIqLiveBoardView } from "@/shared/turniq/readModels";

type Phase = "ready" | "walkin_added" | "completed" | "offline" | "reconnected";

type RushHourSnapshotPayload = {
  board: TurnIqLiveBoardView;
  staffView: null;
  services: Array<{
    id: string;
    name: string;
    durationMinutes: number;
    isAddon: boolean;
  }>;
  fairnessReceiptCount: number;
};

export function TurnIqRushHourHarness() {
  const offlineStore = useMemo(() => new TurnIqOfflineStore(), []);
  const [decision, setDecision] = useState<TurnIqDecisionRecord | null>(null);
  const [groupFeasible, setGroupFeasible] = useState(false);
  const [phase, setPhase] = useState<Phase>("ready");
  const [receiptCount, setReceiptCount] = useState(0);
  const [replay, setReplay] = useState<TurnIqReplayResult | null>(null);
  const [syncedIds, setSyncedIds] = useState<string[]>([]);
  const [offlineStorageSafe, setOfflineStorageSafe] = useState(true);

  useEffect(() => {
    void Promise.all([
      decideSingleCustomer(structuredClone(salonASingleCustomerInputFixture)),
      decideTurnIqGroup(structuredClone(salonAGroupInputFixture)),
    ]).then(([next, group]) => {
      setDecision(next);
      setGroupFeasible(group.assignments.length === salonAGroupInputFixture.request.tasks.length);
    });
  }, []);

  useEffect(() => {
    void Promise.all([
      offlineStore.list(),
      offlineStore.loadSnapshot<RushHourSnapshotPayload>(),
    ])
      .then(([records, snapshot]) => {
        setReceiptCount(snapshot?.payload.fairnessReceiptCount ?? 0);
        if (records.length > 0) setPhase("offline");
      })
      .catch(() => setOfflineStorageSafe(false));
  }, [offlineStore]);

  const skipped = useMemo(
    () => decision?.candidates.filter((candidate) => !candidate.eligible) ?? [],
    [decision],
  );

  async function comparePolicy() {
    const proposed = { ...salonATurnPolicyFixture, policyId: "turniq-salon-a-policy-v2", version: 2, fairnessBandCents: 0 };
    setReplay(await runTurnIqReplay({
      runId: "turniq-rush-hour-replay",
      salonId: salonATurnPolicyFixture.salonId,
      createdAt: "2026-09-02T22:00:00.000Z",
      currentPolicy: salonATurnPolicyFixture,
      proposedPolicy: proposed,
      cases: [{
        caseId: "walkin-001",
        decisionInput: structuredClone(salonASingleCustomerInputFixture),
        actualAssignment: {
          assignedStaffId: decision?.recommendedStaffId ?? null,
          customerAddedAt: "2026-09-02T18:00:00.000Z",
          assignedAt: decision ? "2026-09-02T18:00:08.000Z" : null,
          ownerIntervened: false,
          divergenceReason: null,
        },
      }],
    }));
  }

  async function goOffline() {
    const existing = await offlineStore.list();
    if (existing.length === 0) {
      const snapshot: TurnIqOfflineSnapshot = {
        schemaVersion: TURNIQ_OFFLINE_SCHEMA_VERSION,
        salonId: "00000000-0000-4000-8000-000000000001",
        deviceId: "00000000-0000-4000-8000-000000000002",
        actorUserId: "00000000-0000-4000-8000-000000000003",
        policyVersionId: "00000000-0000-4000-8000-000000000004",
        deviceGeneration: 1,
        lastAckedSequence: 0,
        stateVersion: 0,
        snapshotFingerprint: "a".repeat(64),
        capturedAt: "2026-09-02T20:00:00.000Z",
        payload: {
          board: {
            businessDate: "2026-09-02",
            activePolicyVersionId: "00000000-0000-4000-8000-000000000004",
            ownerActionRequired: false,
            ownerFreedomMessage: "No owner action needed. The team can continue normally.",
            openExceptionCount: 0,
            nextRecommendation: {
              assignmentId: "00000000-0000-4000-8000-000000000008",
              policyVersionId: "00000000-0000-4000-8000-000000000004",
              bookingId: null,
              recommendedStaffId: "00000000-0000-4000-8000-000000000006",
              recommendedStaffName: "Tech 06",
              serviceName: "Deluxe Pedicure",
              explanation: "Cached, appointment-safe recommendation.",
              requestedTechTrustLabel: null,
              redo: null,
              skipped: [],
            },
            redoCandidates: [],
            swaps: [],
            recentCorrections: [],
            staff: [{
              staffId: "00000000-0000-4000-8000-000000000006",
              staffName: "Tech 06",
              state: "active",
              queuePosition: 1,
              turnsConsumed: 0,
              isRecommendedNext: true,
            }, {
              staffId: "00000000-0000-4000-8000-000000000009",
              staffName: "Tech 07",
              state: "not_checked_in",
              queuePosition: null,
              turnsConsumed: 0,
              isRecommendedNext: false,
            }],
            assignments: [{
              assignmentId: "00000000-0000-4000-8000-000000000008",
              policyVersionId: "00000000-0000-4000-8000-000000000004",
              bookingId: null,
              status: "recommended",
              serviceId: "00000000-0000-4000-8000-000000000007",
              serviceName: "Deluxe Pedicure",
              assignedStaffId: null,
              recommendedStaffName: "Tech 06",
              assignedStaffName: null,
              explanation: "Cached, appointment-safe recommendation.",
            }],
          } satisfies TurnIqLiveBoardView,
          staffView: null,
          services: [{
            id: "00000000-0000-4000-8000-000000000007",
            name: "Deluxe Pedicure",
            durationMinutes: 60,
            isAddon: false,
          }],
          fairnessReceiptCount: Math.max(receiptCount, 1),
        },
      };
      await offlineStore.saveSnapshot(snapshot);
      await offlineStore.queue(await buildTurnIqOfflineCommand({
        snapshot,
        pendingCount: 0,
        commandId: "00000000-0000-4000-8000-000000000005",
        clientTimestamp: "2026-09-02T20:00:01.000Z",
        body: {
          type: "shift",
          staffId: "00000000-0000-4000-8000-000000000009",
          action: "check_in",
        },
      }));
    }
    setPhase("offline");
  }

  async function reconnect() {
    const records = await offlineStore.list();
    const ids = [...new Set(records.map((record) => record.command.commandId))];
    for (const record of records) {
      await offlineStore.removeCommitted(record.command.commandId);
    }
    setSyncedIds(ids);
    setPhase("reconnected");
  }

  if (!decision) return <main className="p-8">Loading deterministic TurnIQ demo…</main>;

  return (
    <main className="min-h-screen bg-nq-bg p-4 text-nq-text sm:p-6">
      <PwaRegister />
      <div className="mx-auto max-w-6xl space-y-4">
        {!offlineStorageSafe ? (
          <div role="alert" className="rounded-2xl border border-nq-danger/40 bg-nq-danger/10 p-4 font-semibold text-nq-danger">
            Offline storage corruption detected; actions locked.
          </div>
        ) : null}
        <header className="rounded-3xl border border-nq-gold/40 bg-nq-surface p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-nq-gold">Synthetic TurnIQ M6 · Salon A · 12 technicians</p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <div><h1 className="text-3xl font-bold">Rush-hour Trust Demo</h1><p className="mt-1 text-nq-muted">40 appointments · 10 walk-ins · deterministic · no database/provider</p></div>
            <span className="inline-flex items-center gap-2 rounded-full bg-nq-success/15 px-3 py-2 text-sm font-semibold text-nq-success"><ShieldCheck className="size-4" />No owner action needed</span>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <article className="rounded-3xl border border-nq-gold/40 bg-nq-gold/10 p-5">
            <div className="flex items-center gap-2 text-nq-gold"><Scale className="size-5" /><span className="text-xs font-semibold uppercase tracking-[0.12em]">Next recommended technician</span></div>
            <h2 className="mt-3 text-4xl font-bold">{decision.candidates.find((candidate) => candidate.staffId === decision.recommendedStaffId)?.displayName}</h2>
            <p className="mt-2 text-lg">Deluxe Pedicure + $20 permitted upgrade</p>
            <p className="mt-3 max-w-2xl text-nq-muted">{decision.privacySafeExplanation}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="rounded-full bg-nq-info/15 px-3 py-2 text-sm text-nq-info">Staff-entered request · customer claim recorded</span>
              <span className="rounded-full bg-nq-success/15 px-3 py-2 text-sm text-nq-success">Wait 0–10 min</span>
            </div>
            <Button className="mt-5" onClick={() => setPhase("walkin_added")} disabled={phase !== "ready" || !offlineStorageSafe}>Add walk-in · one tap</Button>
          </article>

          <article className="rounded-3xl border border-nq-border bg-nq-surface p-5">
            <div className="flex items-center gap-2"><Users className="size-5 text-nq-gold" /><h2 className="font-semibold">Operational proof</h2></div>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-nq-muted">Eligible technicians</dt><dd className="font-semibold">{decision.candidates.filter((candidate) => candidate.eligible).length}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-nq-muted">Skipped safely</dt><dd className="font-semibold">{skipped.length}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-nq-muted">4-person group plan</dt><dd className="font-semibold">{groupFeasible ? "Feasible" : "Blocked"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-nq-muted">Owner intervention</dt><dd className="font-semibold">None</dd></div>
            </dl>
          </article>
        </section>

        <section className="rounded-3xl border border-nq-border bg-nq-surface p-5">
          <h2 className="font-semibold">Why earlier-looking technicians were skipped</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {skipped.slice(0, 4).map((candidate) => <li key={candidate.staffId} className="rounded-2xl border border-nq-border/70 p-3"><p className="font-medium">{candidate.displayName}</p><p className="mt-1 text-sm text-nq-muted">{candidate.reasonCodes[0]}</p></li>)}
          </ul>
        </section>

        {phase === "walkin_added" ? (
          <section className="rounded-3xl border border-nq-success/40 bg-nq-success/10 p-5">
            <h2 className="text-xl font-bold">Walk-in assigned in 8 seconds</h2>
            <p className="mt-1 text-nq-muted">Recommendation confirmed; no manual turn calculation.</p>
            <Button className="mt-4" onClick={() => { setReceiptCount(1); setPhase("completed"); }}>Complete service atomically</Button>
          </section>
        ) : null}

        {phase === "completed" || phase === "offline" || phase === "reconnected" ? (
          <section className="grid gap-4 lg:grid-cols-2">
            <article className="rounded-3xl border border-nq-success/40 bg-nq-surface p-5">
              <div className="flex items-center gap-2"><ReceiptText className="size-5 text-nq-success" /><h2 className="font-semibold">Fairness Receipt</h2></div>
              <p className="mt-3">Exactly {receiptCount} durable receipt · policy v1 · $20 fairness band</p>
              <p className="mt-2 text-sm text-nq-muted">Original recommendation, request provenance, skip reasons and command fingerprint preserved.</p>
              <Button className="mt-4" variant="secondary" onClick={() => void comparePolicy()}>What if fairness band = $0?</Button>
              {replay ? <p className="mt-3 text-sm font-medium">Read-only replay: {replay.cases[0].recommendationChanged ? "recommendation changes" : "same recommendation"}; live history unchanged.</p> : null}
            </article>
            <article className="rounded-3xl border border-nq-border bg-nq-surface p-5">
              <h2 className="font-semibold">Primary Offline Device</h2>
              {phase === "completed" ? <Button className="mt-4" variant="secondary" onClick={() => void goOffline()} leftIcon={<CloudOff className="size-4" />}>Lose Internet and continue</Button> : null}
              {phase === "offline" ? <><p className="mt-3 text-sm text-nq-warning">1 encrypted IndexedDB command persisted before success. Providers remain OFF.</p><Button className="mt-4" onClick={() => void reconnect()}>Reconnect and sync</Button></> : null}
              {phase === "reconnected" ? <div className="mt-3 flex items-center gap-2 text-nq-success"><CheckCircle2 className="size-5" /><span>Synced once · {syncedIds.length} unique command · 0 lost · 0 duplicate</span></div> : null}
            </article>
          </section>
        ) : null}

        <footer className="rounded-2xl border border-nq-border bg-nq-surface p-4 text-sm text-nq-muted">
          <span className="inline-flex items-center gap-2"><AlertTriangle className="size-4" />Demo evidence is local/synthetic, not production or pilot proof.</span>
        </footer>
      </div>
    </main>
  );
}
