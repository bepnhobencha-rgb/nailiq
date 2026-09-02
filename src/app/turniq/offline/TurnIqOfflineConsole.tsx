"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CloudOff, LockKeyhole, Play, RefreshCw, Square } from "lucide-react";

import { Button } from "@/components/ui/Button";
import {
  buildTurnIqOfflineCommand,
  type TurnIqOfflineCommandBody,
  type TurnIqOfflineQueueRecord,
  type TurnIqOfflineSnapshot,
  type TurnIqOfflineSnapshotPayload,
} from "@/shared/turniq/offlineContracts";
import { projectTurnIqOfflineBoard } from "@/shared/turniq/offlineProjection";
import { TurnIqOfflineStore } from "@/shared/turniq/offlineStore";

function pendingCount(records: readonly TurnIqOfflineQueueRecord[]) {
  return records.filter((record) => record.status === "queued" || record.status === "syncing").length;
}

export function TurnIqOfflineConsole() {
  const store = useMemo(() => new TurnIqOfflineStore(), []);
  const [snapshot, setSnapshot] = useState<TurnIqOfflineSnapshot<TurnIqOfflineSnapshotPayload> | null>(null);
  const [records, setRecords] = useState<TurnIqOfflineQueueRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<"en" | "vi">("vi");
  const [walkinServiceId, setWalkinServiceId] = useState("");
  const [walkinPartySize, setWalkinPartySize] = useState(1);
  const [overrideStaffId, setOverrideStaffId] = useState("");
  const [overrideReason, setOverrideReason] = useState("");

  const load = useCallback(async () => {
    try {
      const [cached, outbox] = await Promise.all([
        store.loadSnapshot<TurnIqOfflineSnapshotPayload>(),
        store.list(),
      ]);
      setSnapshot(cached);
      setRecords(outbox);
      setError(null);
    } catch {
      setError("storage_corrupt");
    }
  }, [store]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const queue = useCallback(async (body: TurnIqOfflineCommandBody) => {
    if (!snapshot) return false;
    try {
      const outbox = await store.list();
      if (outbox.some((record) => record.status === "conflict")) {
        setError("conflict");
        return false;
      }
      const command = await buildTurnIqOfflineCommand({
        snapshot,
        pendingCount: pendingCount(outbox),
        commandId: crypto.randomUUID(),
        clientTimestamp: new Date().toISOString(),
        body,
      });
      await store.queue(command);
      await load();
      return true;
    } catch {
      setError("storage_failed");
      return false;
    }
  }, [load, snapshot, store]);

  const vi = language === "vi";
  const baselineBoard = snapshot?.payload.board ?? null;
  const board = useMemo(
    () => baselineBoard ? projectTurnIqOfflineBoard(baselineBoard, records) : null,
    [baselineBoard, records],
  );
  const queued = pendingCount(records);
  const conflicts = records.filter((record) => record.status === "conflict").length;
  const services = snapshot?.payload.services ?? [];
  const primaryServices = services.filter((service) => !service.isAddon);
  const offlineSafeAddons = services.filter(
    (service) => service.isAddon && service.durationMinutes === 0,
  );
  const pendingWalkins = records.filter(
    (record) => record.command.body.type === "walkin_intake",
  );

  if (error || !snapshot || !board) {
    return (
      <main className="min-h-screen bg-nq-bg p-6 text-nq-text">
        <div className="mx-auto max-w-xl rounded-3xl border border-nq-danger/40 bg-nq-surface p-6">
          <LockKeyhole className="size-8 text-nq-danger" />
          <h1 className="mt-4 text-2xl font-bold">TurnIQ Offline</h1>
          <p className="mt-2 text-nq-muted">
            {vi
              ? "Không có snapshot đã mã hóa hợp lệ. TurnIQ đã khóa mọi thao tác; hãy kết nối mạng và mở Front Desk."
              : "No valid encrypted snapshot is available. TurnIQ locked all actions; reconnect and open Front Desk."}
          </p>
          <Button className="mt-5" variant="secondary" onClick={() => void load()} leftIcon={<RefreshCw className="size-4" />}>
            {vi ? "Kiểm tra lại" : "Check again"}
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-nq-bg p-4 text-nq-text sm:p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <header className="rounded-3xl border border-nq-warning/40 bg-nq-warning/10 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <CloudOff className="mt-1 size-6 text-nq-warning" />
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-nq-warning">TurnIQ Primary Offline Device</p>
                <h1 className="mt-1 text-2xl font-bold">{vi ? "Tiếp tục ca làm an toàn" : "Continue the shift safely"}</h1>
                <p className="mt-1 text-sm text-nq-muted">
                  {vi
                    ? `${queued} thao tác chưa đồng bộ · ${conflicts} xung đột. Không SMS/email, thanh toán hay đổi lịch cloud.`
                    : `${queued} unsynced action(s) · ${conflicts} conflict(s). No SMS/email, payment, or cloud schedule claims.`}
                </p>
              </div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setLanguage(vi ? "en" : "vi")}>
              {vi ? "English" : "Tiếng Việt"}
            </Button>
          </div>
        </header>

        {conflicts > 0 ? (
          <div role="alert" className="rounded-2xl border border-nq-danger/40 bg-nq-danger/10 p-4">
            <div className="flex gap-2"><AlertTriangle className="size-5 text-nq-danger" /><p className="font-semibold">{vi ? "Đã dừng: Owner cần hòa giải xung đột sau khi có mạng." : "Stopped: an Owner must reconcile the conflict after reconnecting."}</p></div>
          </div>
        ) : null}

        <section className="rounded-3xl border border-nq-gold/35 bg-nq-surface p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-nq-gold">{vi ? "Đề xuất đã lưu" : "Cached recommendation"}</p>
          {board.nextRecommendation ? (
            <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_auto]">
              <div>
                <h2 className="text-3xl font-bold">{board.nextRecommendation.recommendedStaffName}</h2>
                <p className="mt-1 text-sm text-nq-muted">{board.nextRecommendation.serviceName}</p>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-nq-muted">{board.nextRecommendation.explanation}</p>
              </div>
              <Button
                size="lg"
                disabled={conflicts > 0}
                onClick={() => void queue({
                  type: "assignment",
                  assignmentId: board.nextRecommendation!.assignmentId,
                  action: "confirm",
                  assignedStaffId: board.nextRecommendation!.recommendedStaffId,
                })}
              >
                {vi ? "Xác nhận lượt offline" : "Confirm offline"}
              </Button>
              <div className="lg:col-span-2 rounded-2xl border border-nq-border/70 p-4">
                <p className="text-sm font-semibold">{vi ? "Ngoại lệ có lý do" : "Reasoned exception"}</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1.5fr_auto]">
                  <label className="text-sm">
                    {vi ? "Đổi sang thợ" : "Assign instead"}
                    <select
                      className="mt-1 min-h-11 w-full rounded-xl border border-nq-border bg-nq-bg px-3"
                      value={overrideStaffId}
                      onChange={(event) => setOverrideStaffId(event.target.value)}
                    >
                      <option value="">{vi ? "Chọn thợ" : "Select technician"}</option>
                      {board.staff
                        .filter((staff) => staff.state === "active" && staff.staffId !== board.nextRecommendation?.recommendedStaffId)
                        .map((staff) => <option key={staff.staffId} value={staff.staffId}>{staff.staffName}</option>)}
                    </select>
                  </label>
                  <label className="text-sm">
                    {vi ? "Lý do bắt buộc" : "Required reason"}
                    <input
                      className="mt-1 min-h-11 w-full rounded-xl border border-nq-border bg-nq-bg px-3"
                      value={overrideReason}
                      maxLength={500}
                      onChange={(event) => setOverrideReason(event.target.value)}
                    />
                  </label>
                  <Button
                    className="self-end"
                    variant="secondary"
                    disabled={conflicts > 0 || !overrideStaffId || !overrideReason.trim()}
                    onClick={() => void (async () => {
                      const saved = await queue({
                        type: "assignment",
                        assignmentId: board.nextRecommendation!.assignmentId,
                        action: "override",
                        assignedStaffId: overrideStaffId,
                        reason: overrideReason.trim(),
                      });
                      if (saved) {
                        setOverrideStaffId("");
                        setOverrideReason("");
                      }
                    })()}
                  >
                    {vi ? "Lưu override" : "Save override"}
                  </Button>
                </div>
              </div>
            </div>
          ) : <p className="mt-3 text-nq-muted">{vi ? "Không có đề xuất đã xác minh trong snapshot này." : "No verified recommendation is cached in this snapshot."}</p>}
        </section>

        <section className="rounded-3xl border border-nq-border bg-nq-surface p-5">
          <h2 className="text-lg font-semibold">{vi ? "Thêm khách walk-in offline" : "Add an offline walk-in"}</h2>
          <p className="mt-1 text-sm text-nq-muted">
            {vi
              ? "Tạo vé không chứa tên/số điện thoại. Sau khi có mạng, tiếp tân đối chiếu danh tính; chưa có thông báo nào được gửi."
              : "Creates a ticket with no name or phone. The desk matches identity after reconnecting; no notification is sent."}
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_8rem_auto]">
            <label className="text-sm font-medium">
              {vi ? "Dịch vụ" : "Service"}
              <select
                className="mt-1 min-h-11 w-full rounded-xl border border-nq-border bg-nq-bg px-3"
                value={walkinServiceId}
                onChange={(event) => setWalkinServiceId(event.target.value)}
              >
                <option value="">{vi ? "Chọn dịch vụ" : "Select service"}</option>
                {primaryServices.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
              </select>
            </label>
            <label className="text-sm font-medium">
              {vi ? "Số khách" : "Party"}
              <input
                className="mt-1 min-h-11 w-full rounded-xl border border-nq-border bg-nq-bg px-3"
                type="number"
                min={1}
                max={12}
                value={walkinPartySize}
                onChange={(event) => setWalkinPartySize(Math.max(1, Math.min(12, Number(event.target.value) || 1)))}
              />
            </label>
            <Button
              className="self-end"
              disabled={conflicts > 0 || !walkinServiceId}
              onClick={() => void (async () => {
                const saved = await queue({
                  type: "walkin_intake",
                  localTicketId: crypto.randomUUID(),
                  serviceId: walkinServiceId,
                  partySize: walkinPartySize,
                });
                if (saved) {
                  setWalkinServiceId("");
                  setWalkinPartySize(1);
                }
              })()}
            >
              {vi ? "Lưu vé offline" : "Save offline ticket"}
            </Button>
          </div>
          {pendingWalkins.length > 0 ? (
            <p className="mt-3 text-sm font-semibold text-nq-warning">
              {vi ? `${pendingWalkins.length} vé walk-in đang chờ đồng bộ` : `${pendingWalkins.length} walk-in ticket(s) await sync`}
            </p>
          ) : null}
        </section>

        <section className="rounded-3xl border border-nq-border bg-nq-surface p-5">
          <h2 className="text-lg font-semibold">{vi ? "Đội ngũ hôm nay" : "Today's team"}</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {board.staff.map((staff) => {
              const action = staff.state === "not_checked_in" || staff.state === "checked_out"
                ? "check_in" as const
                : staff.state === "active"
                  ? "break" as const
                  : staff.state === "approved_break"
                    ? "return" as const
                    : null;
              return (
                <li key={staff.staffId} className="rounded-2xl border border-nq-border/70 p-3">
                  <p className="font-semibold">{staff.staffName}</p>
                  <p className="mt-1 text-sm text-nq-muted">{staff.state}{staff.queuePosition ? ` · #${staff.queuePosition}` : ""}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {action ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={conflicts > 0}
                        onClick={() => {
                          const reason = action === "break"
                            ? window.prompt(vi ? "Lý do nghỉ đã được duyệt" : "Approved break reason")?.trim()
                            : undefined;
                          if (action === "break" && !reason) return;
                          void queue({ type: "shift", staffId: staff.staffId, action, ...(reason ? { reason } : {}) });
                        }}
                      >
                        {action === "check_in" ? "Check-in" : action === "break" ? (vi ? "Nghỉ" : "Break") : (vi ? "Quay lại" : "Return")}
                      </Button>
                    ) : null}
                    {staff.state === "active" || staff.state === "approved_break" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={conflicts > 0}
                        onClick={() => void queue({ type: "shift", staffId: staff.staffId, action: "check_out" })}
                      >
                        {vi ? "Kết ca" : "Check out"}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="rounded-3xl border border-nq-border bg-nq-surface p-5">
          <h2 className="text-lg font-semibold">{vi ? "Công việc đang hoạt động" : "Active assignments"}</h2>
          <ul className="mt-3 space-y-3">
            {board.assignments.filter((item) => item.status === "confirmed" || item.status === "in_progress").map((assignment) => (
              <li key={assignment.assignmentId} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-nq-border/70 p-3">
                <div><p className="font-semibold">{assignment.assignedStaffName ?? assignment.recommendedStaffName}</p><p className="text-sm text-nq-muted">{assignment.serviceName} · {assignment.status}</p></div>
                <Button
                  size="sm"
                  disabled={conflicts > 0}
                  leftIcon={assignment.status === "confirmed" ? <Play className="size-4" /> : <Square className="size-4" />}
                  onClick={() => void queue({
                    type: "assignment",
                    assignmentId: assignment.assignmentId,
                    action: assignment.status === "confirmed" ? "start" : "complete",
                  })}
                >
                  {assignment.status === "confirmed" ? (vi ? "Bắt đầu" : "Start") : (vi ? "Hoàn tất" : "Complete")}
                </Button>
                {assignment.status === "in_progress" && assignment.serviceId && offlineSafeAddons.length > 0 ? (
                  <label className="text-sm font-medium">
                    <span className="sr-only">{vi ? "Thêm add-on không tăng thời gian" : "Add a zero-time add-on"}</span>
                    <select
                      className="min-h-10 rounded-xl border border-nq-border bg-nq-bg px-3"
                      defaultValue=""
                      disabled={conflicts > 0}
                      onChange={(event) => {
                        const addonId = event.target.value;
                        if (!addonId) return;
                        void queue({
                          type: "service_update",
                          assignmentId: assignment.assignmentId,
                          serviceId: assignment.serviceId!,
                          addonServiceIds: [addonId],
                        });
                        event.target.value = "";
                      }}
                    >
                      <option value="">{vi ? "+ Add-on 0 phút" : "+ Zero-time add-on"}</option>
                      {offlineSafeAddons.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
                    </select>
                  </label>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
