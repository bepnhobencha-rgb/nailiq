"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cloud, CloudOff, HardDrive, ShieldAlert, Smartphone } from "lucide-react";

import { Button } from "@/components/ui/Button";
import {
  inspectTurnIqOfflineDeviceAction,
  pairTurnIqOfflineDeviceAction,
  replayTurnIqOfflineCommandAction,
  resolveTurnIqOfflineReconciliationAction,
  revokeTurnIqOfflineDeviceAction,
  syncTurnIqOfflineSnapshotAction,
} from "@/shared/turniq/offlineActions";
import {
  fingerprintTurnIqOfflineCommand,
  TURNIQ_OFFLINE_SCHEMA_VERSION,
  type TurnIqOfflineCommand,
  type TurnIqOfflineLease,
  type TurnIqOfflineQueueRecord,
  type TurnIqOfflineServiceCatalogEntry,
  type TurnIqOfflineSnapshotPayload,
} from "@/shared/turniq/offlineContracts";
import { TurnIqOfflineStore } from "@/shared/turniq/offlineStore";
import {
  projectTurnIqOfflineBoard,
  projectTurnIqOfflineStaffView,
} from "@/shared/turniq/offlineProjection";
import { canonicalTurnIqJson, sha256TurnIqHex } from "@/shared/turniq/fingerprint";
import type { TurnIqLiveBoardView, TurnIqStaffView } from "@/shared/turniq/readModels";
import type {
  TurnIqAssignmentActionInput,
  TurnIqCommandActionResult,
  TurnIqShiftActionInput,
} from "@/shared/turniq/serverContracts";

type Runtime = {
  board: TurnIqLiveBoardView | null;
  staffView: TurnIqStaffView | null;
  applyShift: (input: TurnIqShiftActionInput) => Promise<TurnIqCommandActionResult>;
  applyAssignment: (input: TurnIqAssignmentActionInput) => Promise<TurnIqCommandActionResult>;
};

type Props = {
  slug: string;
  salonId: string;
  language: "en" | "vi";
  offline: boolean;
  canPair: boolean;
  board: TurnIqLiveBoardView | null;
  staffView: TurnIqStaffView | null;
  services: readonly TurnIqOfflineServiceCatalogEntry[];
  applyShiftOnline: (input: TurnIqShiftActionInput) => Promise<TurnIqCommandActionResult>;
  applyAssignmentOnline: (input: TurnIqAssignmentActionInput) => Promise<TurnIqCommandActionResult>;
  onRefresh: () => Promise<void>;
  children: (runtime: Runtime) => React.ReactNode;
};

class SerialQueue {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }
}

function labelForDevice(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || "Salon device";
  return `NailIQ ${platform}`.slice(0, 100);
}

function queued(records: readonly TurnIqOfflineQueueRecord[]) {
  return records.filter((record) => record.status === "queued" || record.status === "syncing");
}

function offlineBodyFor(
  input: TurnIqShiftActionInput | TurnIqAssignmentActionInput,
  kind: "shift" | "assignment",
): TurnIqOfflineCommand["body"] | null {
  if (kind === "shift") {
    const shift = input as TurnIqShiftActionInput;
    if (shift.command.type === "hold" || shift.command.type === "release_hold") return null;
    return {
      type: "shift",
      staffId: shift.staffId,
      action: shift.command.type,
      ...(shift.command.type === "break" ? { reason: shift.command.reason } : {}),
    };
  }
  const assignment = input as TurnIqAssignmentActionInput;
  if (assignment.command.type === "confirm") {
    return {
      type: "assignment",
      assignmentId: assignment.assignmentId,
      action: "confirm",
      assignedStaffId: assignment.command.assignedStaffId,
    };
  }
  if (assignment.command.type === "override") {
    return {
      type: "assignment",
      assignmentId: assignment.assignmentId,
      action: "override",
      assignedStaffId: assignment.command.assignedStaffId,
      reason: assignment.command.reason,
    };
  }
  return {
    type: "assignment",
    assignmentId: assignment.assignmentId,
    action: assignment.command.type,
  };
}

export function TurnIqOfflineBoundary({
  slug,
  salonId,
  language,
  offline,
  canPair,
  board,
  staffView,
  services,
  applyShiftOnline,
  applyAssignmentOnline,
  onRefresh,
  children,
}: Props) {
  const vi = language === "vi";
  const store = useMemo(() => new TurnIqOfflineStore(), []);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [lease, setLease] = useState<TurnIqOfflineLease | null>(null);
  const [records, setRecords] = useState<TurnIqOfflineQueueRecord[]>([]);
  const [storageFailed, setStorageFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncPaused, setSyncPaused] = useState(false);
  const [queueCoordinator] = useState(() => new SerialQueue());
  const snapshotFingerprintRef = useRef<string | null>(null);

  const refreshRecords = useCallback(async () => {
    try {
      setRecords(await store.list());
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
  }, [store]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let identity = await store.loadDeviceIdentity();
        if (!identity) {
          identity = { deviceId: crypto.randomUUID(), label: labelForDevice() };
          await store.saveDeviceIdentity(identity);
        }
        if (cancelled) return;
        setDeviceId(identity.deviceId);
        await refreshRecords();
        if (!offline) {
          const result = await inspectTurnIqOfflineDeviceAction({ slug, deviceId: identity.deviceId });
          if (!cancelled) setLease(result.ok ? result.lease : null);
        }
      } catch {
        if (!cancelled) setStorageFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [offline, refreshRecords, slug, store]);

  useEffect(() => {
    if (
      offline || !lease || lease.status !== "primary" || !board?.activePolicyVersionId ||
      queued(records).length > 0 || records.some((record) => record.status === "conflict")
    ) return;
    const policyVersionId = board.activePolicyVersionId;
    let cancelled = false;
    void (async () => {
      const capturedAt = new Date().toISOString();
      const payload: TurnIqOfflineSnapshotPayload = { board, staffView, services };
      const fingerprint = await sha256TurnIqHex(canonicalTurnIqJson({
        kind: "turniq_offline_snapshot_v1",
        salonId,
        policyVersionId,
        stateVersion: lease.stateVersion,
        payload,
      }));
      if (snapshotFingerprintRef.current === fingerprint) return;
      const synced = await syncTurnIqOfflineSnapshotAction({
        slug,
        deviceId: lease.deviceId,
        deviceGeneration: lease.generation,
        policyVersionId,
        snapshotFingerprint: fingerprint,
        capturedAt,
      });
      if (!synced.ok || cancelled) return;
      await store.saveSnapshot({
        schemaVersion: TURNIQ_OFFLINE_SCHEMA_VERSION,
        salonId,
        policyVersionId,
        deviceId: lease.deviceId,
        deviceGeneration: lease.generation,
        actorUserId: lease.actorUserId,
        lastAckedSequence: lease.lastAckedSequence,
        stateVersion: synced.lease.stateVersion,
        snapshotFingerprint: fingerprint,
        capturedAt,
        payload,
      });
      if (!cancelled) {
        snapshotFingerprintRef.current = fingerprint;
        setLease(synced.lease);
      }
    })().catch(() => {
      if (!cancelled) setStorageFailed(true);
    });
    return () => { cancelled = true; };
  }, [board, lease, offline, records, salonId, services, slug, staffView, store]);

  useEffect(() => {
    if (offline || !lease || lease.status !== "primary" || queued(records).length === 0 || busy || syncPaused) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      setBusy(true);
      for (const record of queued(records)) {
        if (cancelled) return;
        const syncing = { ...record, status: "syncing" as const };
        await store.update(syncing);
        const result = await replayTurnIqOfflineCommandAction({ slug, command: record.command });
        if (!result.ok) {
          if (result.code === "server_error") {
            await store.update({ ...record, status: "queued" });
            setSyncPaused(true);
          } else {
            const conflictId = "conflictId" in result ? result.conflictId : undefined;
            await store.update({
              ...record,
              status: "conflict",
              conflictCode: result.code === "invalid_input" || result.code === "unauthorized" || result.code === "forbidden" || result.code === "feature_disabled" || result.code === "rollout_stage_blocked" ? "domain_conflict" : result.code,
              ...(conflictId ? { conflictId } : {}),
            });
          }
          break;
        }
        await store.removeCommitted(record.command.commandId);
        setLease((current) => current ? {
          ...current,
          stateVersion: result.result.offlineStateVersion,
          lastAckedSequence: record.command.localSequence,
        } : current);
      }
      await refreshRecords();
      if (!cancelled) await onRefresh();
    }).catch(() => setStorageFailed(true)).finally(() => {
      if (!cancelled) setBusy(false);
    });
    return () => { cancelled = true; };
  }, [busy, lease, offline, onRefresh, records, refreshRecords, slug, store, syncPaused]);

  const resolveConflict = useCallback(async (record: TurnIqOfflineQueueRecord) => {
    if (!record.conflictId || offline || !canPair || !deviceId) return;
    const reason = window.prompt(vi
      ? "Ghi lý do giữ dữ liệu cloud và bỏ thao tác offline này"
      : "Record why server truth should be kept and this offline action discarded")?.trim();
    if (!reason) return;
    setBusy(true);
    const result = await resolveTurnIqOfflineReconciliationAction({
      slug,
      deviceId,
      conflictId: record.conflictId,
      reason,
    });
    if (result.ok) {
      await store.removeCommitted(record.command.commandId);
      await refreshRecords();
      await onRefresh();
    }
    setBusy(false);
  }, [canPair, deviceId, offline, onRefresh, refreshRecords, slug, store, vi]);

  const queueCommand = useCallback(async (
    input: TurnIqShiftActionInput | TurnIqAssignmentActionInput,
    kind: "shift" | "assignment",
  ): Promise<TurnIqCommandActionResult> => {
    if (!lease || lease.status !== "primary") return { ok: false, code: "offline_read_only" };
    const snapshot = await store.loadSnapshot<TurnIqOfflineSnapshotPayload>();
    if (!snapshot || snapshot.deviceGeneration !== lease.generation) {
      return { ok: false, code: "offline_read_only" };
    }
    const body = offlineBodyFor(input, kind);
    if (!body) return { ok: false, code: "offline_read_only" };
    try {
      return await queueCoordinator.run(async () => {
      const current = await store.list();
      const pendingCount = queued(current).length;
      const draft: Omit<TurnIqOfflineCommand, "requestFingerprint"> = {
        schemaVersion: TURNIQ_OFFLINE_SCHEMA_VERSION,
        commandId: input.commandId,
        salonId,
        deviceId: lease.deviceId,
        deviceGeneration: lease.generation,
        policyVersionId: input.policyVersionId,
        localSequence: lease.lastAckedSequence + pendingCount + 1,
        expectedStateVersion: snapshot.stateVersion + pendingCount,
        actorUserId: lease.actorUserId,
        clientTimestamp: new Date().toISOString(),
        snapshotFingerprint: snapshot.snapshotFingerprint,
        body,
      };
      const command: TurnIqOfflineCommand = {
        ...draft,
        requestFingerprint: await fingerprintTurnIqOfflineCommand(draft),
      };
      await store.queue(command);
      await refreshRecords();
      return {
        ok: true,
        result: {
          commandId: command.commandId,
          replayed: false,
          aggregateId: body.type === "shift" ? body.staffId : body.type === "assignment" ? body.assignmentId : command.commandId,
          status: "queued_offline",
          stateVersion: command.expectedStateVersion + 1,
          fairnessReceiptId: null,
        },
      } satisfies TurnIqCommandActionResult;
      });
    } catch {
      setStorageFailed(true);
      return { ok: false, code: "offline_storage_failed" };
    }
  }, [lease, queueCoordinator, refreshRecords, salonId, store]);

  const applyShift = useCallback((input: TurnIqShiftActionInput) =>
    offline ? queueCommand(input, "shift") : applyShiftOnline(input),
  [applyShiftOnline, offline, queueCommand]);
  const applyAssignment = useCallback((input: TurnIqAssignmentActionInput) =>
    offline ? queueCommand(input, "assignment") : applyAssignmentOnline(input),
  [applyAssignmentOnline, offline, queueCommand]);

  const pair = useCallback(async () => {
    if (!deviceId || offline || !canPair) return;
    if (records.length > 0) {
      window.alert(vi
        ? "Máy này còn thao tác offline hoặc xung đột. Hãy đồng bộ/hòa giải trước khi đổi máy chính."
        : "This device still has offline actions or conflicts. Sync or reconcile them before changing the primary device.");
      return;
    }
    if (!window.confirm(vi
      ? "Đặt máy này làm Thiết bị Offline Chính? Thiết bị chính cũ sẽ bị thu hồi."
      : "Make this the Primary Offline Device? The previous primary device will be revoked.")) return;
    setBusy(true);
    const result = await pairTurnIqOfflineDeviceAction({ slug, deviceId, label: labelForDevice() });
    if (result.ok) setLease(result.lease);
    setBusy(false);
  }, [canPair, deviceId, offline, records.length, slug, vi]);

  const revoke = useCallback(async () => {
    if (!deviceId || offline || !canPair) return;
    if (records.length > 0) {
      window.alert(vi
        ? "Không thể tắt khi còn thao tác offline hoặc xung đột. Hãy đồng bộ/hòa giải trước."
        : "Offline writes cannot be disabled while actions or conflicts remain. Sync or reconcile them first.");
      return;
    }
    setBusy(true);
    const result = await revokeTurnIqOfflineDeviceAction({
      slug,
      deviceId,
      reason: "Owner disabled offline writes from this device",
    });
    if (result.ok) {
      const nextIdentity = { deviceId: crypto.randomUUID(), label: labelForDevice() };
      await store.saveDeviceIdentity(nextIdentity);
      setDeviceId(nextIdentity.deviceId);
      setLease(null);
      snapshotFingerprintRef.current = null;
    }
    setBusy(false);
  }, [canPair, deviceId, offline, records.length, slug, store, vi]);

  const unsyncedCount = queued(records).length;
  const conflictCount = records.filter((record) => record.status === "conflict").length;
  const isPrimary = lease?.status === "primary";
  const projectedBoard = useMemo(
    () => board && unsyncedCount > 0 ? projectTurnIqOfflineBoard(board, records) : board,
    [board, records, unsyncedCount],
  );
  const projectedStaffView = useMemo(
    () => staffView && projectedBoard && unsyncedCount > 0
      ? projectTurnIqOfflineStaffView(staffView, projectedBoard)
      : staffView,
    [projectedBoard, staffView, unsyncedCount],
  );

  return (
    <>
      <section
        aria-label={vi ? "Trạng thái TurnIQ offline" : "TurnIQ offline status"}
        className={`rounded-2xl border px-4 py-3 ${
          storageFailed || conflictCount > 0
            ? "border-nq-danger/40 bg-nq-danger/10"
            : offline
              ? "border-nq-warning/40 bg-nq-warning/10"
              : "border-nq-border bg-nq-surface"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            {storageFailed || conflictCount > 0 ? <ShieldAlert className="mt-0.5 size-5 text-nq-danger" /> : offline ? <CloudOff className="mt-0.5 size-5 text-nq-warning" /> : <Cloud className="mt-0.5 size-5 text-nq-success" />}
            <div>
              <p className="font-semibold text-nq-text">
                {storageFailed
                  ? (vi ? "Bộ nhớ offline không an toàn — đã khóa thao tác" : "Offline storage is unsafe — actions are locked")
                  : conflictCount > 0
                    ? (vi ? `${conflictCount} xung đột cần Owner xử lý` : `${conflictCount} conflict(s) need Owner review`)
                    : offline && isPrimary
                      ? (vi ? `Đang offline an toàn · ${unsyncedCount} việc chưa đồng bộ` : `Safely offline · ${unsyncedCount} unsynced action(s)`)
                      : offline
                        ? (vi ? "Offline chỉ xem — đây không phải máy chính" : "Offline read-only — this is not the primary device")
                        : isPrimary
                          ? (vi ? `Thiết bị Offline Chính · ${unsyncedCount} việc chưa đồng bộ` : `Primary Offline Device · ${unsyncedCount} unsynced action(s)`)
                          : (vi ? "Chưa chỉ định Thiết bị Offline Chính" : "No Primary Offline Device on this device")}
              </p>
              <p className="mt-1 text-sm text-nq-muted">
                {vi
                  ? "Offline không bao giờ báo đã gửi SMS/email, thu tiền hoặc đổi lịch cloud."
                  : "Offline never claims SMS/email, payment, or cloud booking changes succeeded."}
              </p>
            </div>
          </div>
          {canPair && !offline ? (
            <div className="flex flex-wrap gap-2">
              {syncPaused && isPrimary ? (
                <Button size="sm" variant="secondary" onClick={() => setSyncPaused(false)}>
                  {vi ? "Thử đồng bộ lại" : "Retry sync"}
                </Button>
              ) : null}
              {isPrimary ? (
                <Button size="sm" variant="secondary" loading={busy} onClick={revoke} leftIcon={<HardDrive className="size-4" />}>
                  {vi ? "Tắt ghi offline" : "Disable offline writes"}
                </Button>
              ) : (
                <Button size="sm" variant="secondary" loading={busy} onClick={pair} leftIcon={<Smartphone className="size-4" />}>
                  {vi ? "Đặt máy này làm máy chính" : "Make this the primary device"}
                </Button>
              )}
            </div>
          ) : null}
        </div>
        {records.filter((record) => record.status === "conflict").map((record) => (
          <div key={record.command.commandId} className="mt-3 rounded-xl border border-nq-danger/30 p-3 text-sm">
            <p className="font-semibold text-nq-danger">
              {record.conflictCode ?? "domain_conflict"} · #{record.command.localSequence}
            </p>
            <p className="mt-1 text-nq-muted">
              {vi ? "Không có dữ liệu nào bị ghi đè. Owner cần xem và quyết định." : "Nothing was overwritten. An Owner must review and decide."}
            </p>
            {canPair && !offline && record.conflictId ? (
              <Button className="mt-2" size="sm" variant="secondary" loading={busy} onClick={() => void resolveConflict(record)}>
                {vi ? "Giữ dữ liệu cloud, bỏ thao tác offline" : "Keep server truth; discard offline action"}
              </Button>
            ) : null}
          </div>
        ))}
      </section>
      {children({
        board: projectedBoard,
        staffView: projectedStaffView,
        applyShift,
        applyAssignment,
      })}
    </>
  );
}
