"use client";

import { useRef, useState, useTransition } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  Coffee,
  Download,
  LogIn,
  Play,
  QrCode,
  RotateCcw,
  Square,
  UserX,
  Users,
  Wrench,
} from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type {
  TurnIqExceptionInboxView,
  TurnIqLiveBoardView,
  TurnIqStaffShiftState,
  TurnIqStaffView,
} from "@/shared/turniq/readModels";
import type {
  TurnIqAssignmentActionInput,
  TurnIqCommandActionResult,
  TurnIqCorrectionActionInput,
  TurnIqCreateDisputeActionInput,
  TurnIqCreateSkipDisputeActionInput,
  TurnIqExceptionActionInput,
  TurnIqResolveDisputeActionInput,
  TurnIqRefusalActionInput,
  TurnIqRedoActionInput,
  TurnIqShiftActionInput,
  TurnIqSwapActionInput,
} from "@/shared/turniq/serverContracts";

type TurnIqOperationsPanelProps = {
  board: TurnIqLiveBoardView | null;
  staffView: TurnIqStaffView | null;
  exceptionInbox: TurnIqExceptionInboxView | null;
  language: "en" | "vi";
  slug: string;
  canManageTeam: boolean;
  canSeeExceptionInbox: boolean;
  canCorrectRecords: boolean;
  onApplyShiftCommand: (
    input: TurnIqShiftActionInput,
  ) => Promise<TurnIqCommandActionResult>;
  onApplyAssignmentCommand: (
    input: TurnIqAssignmentActionInput,
  ) => Promise<TurnIqCommandActionResult>;
  onApplyRefusalCommand: (
    input: TurnIqRefusalActionInput,
  ) => Promise<TurnIqCommandActionResult>;
  onApplyRedoCommand: (
    input: TurnIqRedoActionInput,
  ) => Promise<TurnIqCommandActionResult>;
  onApplySwapCommand: (
    input: TurnIqSwapActionInput,
  ) => Promise<TurnIqCommandActionResult>;
  onApplyCorrectionCommand: (
    input: TurnIqCorrectionActionInput,
  ) => Promise<TurnIqCommandActionResult>;
  onCreateDispute: (
    input: TurnIqCreateDisputeActionInput,
  ) => Promise<TurnIqCommandActionResult>;
  onCreateSkipDispute: (
    input: TurnIqCreateSkipDisputeActionInput,
  ) => Promise<TurnIqCommandActionResult>;
  onResolveDispute: (
    input: TurnIqResolveDisputeActionInput,
  ) => Promise<TurnIqCommandActionResult>;
  onApplyExceptionCommand: (
    input: TurnIqExceptionActionInput,
  ) => Promise<TurnIqCommandActionResult>;
  onRefresh: () => Promise<void>;
};

type ShiftCommandType = "check_in" | "break" | "return" | "release_hold";

type PendingCommand =
  | { key: string; kind: "shift"; input: TurnIqShiftActionInput }
  | { key: string; kind: "assignment"; input: TurnIqAssignmentActionInput }
  | { key: string; kind: "refusal"; input: TurnIqRefusalActionInput }
  | { key: string; kind: "redo"; input: TurnIqRedoActionInput }
  | { key: string; kind: "swap"; input: TurnIqSwapActionInput }
  | { key: string; kind: "correction"; input: TurnIqCorrectionActionInput }
  | { key: string; kind: "create_dispute"; input: TurnIqCreateDisputeActionInput }
  | { key: string; kind: "create_skip_dispute"; input: TurnIqCreateSkipDisputeActionInput }
  | { key: string; kind: "resolve_dispute"; input: TurnIqResolveDisputeActionInput }
  | { key: string; kind: "exception"; input: TurnIqExceptionActionInput };

type ReviewEditor =
  | {
      kind: "create_dispute";
      receiptId: string;
      policyVersionId: string;
    }
  | {
      kind: "create_skip_dispute";
      assignmentId: string;
      policyVersionId: string;
    }
  | {
      kind: "resolve_dispute";
      disputeId: string;
      policyVersionId: string;
      resolution: "resolved" | "dismissed";
    }
  | {
      kind: "resolve_exception";
      exceptionId: string;
      policyVersionId: string;
      resolution: "resolve_exception" | "dismiss_exception";
    };

const SHIFT_BADGE: Record<
  TurnIqStaffShiftState,
  { variant: "success" | "warning" | "neutral"; en: string; vi: string }
> = {
  active: { variant: "success", en: "Ready", vi: "Sẵn sàng" },
  approved_break: { variant: "warning", en: "On break", vi: "Đang nghỉ" },
  temporary_hold: { variant: "warning", en: "On hold", vi: "Tạm giữ" },
  checked_out: { variant: "neutral", en: "Checked out", vi: "Đã rời ca" },
  not_checked_in: { variant: "neutral", en: "Not checked in", vi: "Chưa check-in" },
};

function actionError(code: string, vi: boolean): string {
  if (code === "stale_state") {
    return vi
      ? "Trạng thái vừa thay đổi. TurnIQ đã dừng an toàn và đang làm mới."
      : "The state changed. TurnIQ stopped safely and is refreshing.";
  }
  if (code === "feature_disabled") {
    return vi ? "TurnIQ đang tắt cho salon này." : "TurnIQ is off for this salon.";
  }
  if (code === "policy_configuration_required") {
    return vi
      ? "Salon chưa duyệt quy tắc lượt/credit cho loại redo này. TurnIQ đã giữ nguyên lượt và chuyển một ngoại lệ cho Owner/Admin."
      : "This salon has not approved the turn/credit rule for that redo category. TurnIQ preserved the queue and sent an exception to Owner/Admin.";
  }
  if (code === "forbidden") {
    return vi
      ? "Tài khoản này không có quyền thực hiện thao tác."
      : "This account cannot perform that action.";
  }
  if (code === "offline_read_only") {
    return vi
      ? "Offline chỉ xem: chỉ Thiết bị Offline Chính đã đồng bộ mới được thao tác."
      : "Offline is read-only: only the synchronized Primary Offline Device may act.";
  }
  if (code === "offline_storage_failed") {
    return vi
      ? "Không thể lưu an toàn trên máy. TurnIQ đã khóa thao tác; chưa có gì thay đổi."
      : "TurnIQ could not persist safely on this device. The action was blocked.";
  }
  return vi
    ? "Chưa thể hoàn tất. Không có thay đổi mới nào được lưu; bạn có thể thử lại."
    : "The action did not finish. No new change was saved; you can retry.";
}

function shiftActionFor(state: TurnIqStaffShiftState): ShiftCommandType | null {
  if (state === "not_checked_in" || state === "checked_out") return "check_in";
  if (state === "active") return "break";
  if (state === "approved_break") return "return";
  if (state === "temporary_hold") return "release_hold";
  return null;
}

export function TurnIqOperationsPanel({
  board,
  staffView,
  exceptionInbox,
  language,
  slug,
  canManageTeam,
  canSeeExceptionInbox,
  canCorrectRecords,
  onApplyShiftCommand,
  onApplyAssignmentCommand,
  onApplyRefusalCommand,
  onApplyRedoCommand,
  onApplySwapCommand,
  onApplyCorrectionCommand,
  onCreateDispute,
  onCreateSkipDispute,
  onResolveDispute,
  onApplyExceptionCommand,
  onRefresh,
}: TurnIqOperationsPanelProps) {
  const vi = language === "vi";
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [reasonEditor, setReasonEditor] = useState<{
    staffId: string;
    staffName: string;
  } | null>(null);
  const [breakReason, setBreakReason] = useState("");
  const [reviewEditor, setReviewEditor] = useState<ReviewEditor | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [disputeCategory, setDisputeCategory] = useState<
    TurnIqCreateDisputeActionInput["command"]["category"]
  >("assignment");
  const [refusalEditor, setRefusalEditor] = useState<{
    assignmentId: string;
    policyVersionId: string;
    staffName: string;
  } | null>(null);
  const [refusalCategory, setRefusalCategory] = useState<
    TurnIqRefusalActionInput["command"]["category"]
  >("customer_declined");
  const [refusalReason, setRefusalReason] = useState("");
  const [redoEditorOpen, setRedoEditorOpen] = useState(false);
  const [redoOriginalAssignmentId, setRedoOriginalAssignmentId] = useState("");
  const [redoCategory, setRedoCategory] = useState<
    TurnIqRedoActionInput["command"]["category"]
  >("quality_issue");
  const [redoNote, setRedoNote] = useState("");
  const [swapEditorOpen, setSwapEditorOpen] = useState(false);
  const [swapAssignmentId, setSwapAssignmentId] = useState("");
  const [swapToStaffId, setSwapToStaffId] = useState("");
  const [swapReason, setSwapReason] = useState("");
  const [correctionEditorOpen, setCorrectionEditorOpen] = useState(false);
  const [correctionAssignmentId, setCorrectionAssignmentId] = useState("");
  const [correctionActualStaffId, setCorrectionActualStaffId] = useState("");
  const [correctionCategory, setCorrectionCategory] = useState<
    TurnIqCorrectionActionInput["category"]
  >("wrong_technician");
  const [correctionReason, setCorrectionReason] = useState("");
  const deviceIdRef = useRef<string | null>(null);
  const localSequenceRef = useRef(0);
  const retryRef = useRef<PendingCommand | null>(null);

  function nextEnvelope() {
    deviceIdRef.current ??= crypto.randomUUID();
    localSequenceRef.current += 1;
    return {
      commandId: crypto.randomUUID(),
      deviceId: deviceIdRef.current,
      localSequence: localSequenceRef.current,
    };
  }

  function shiftCommand(
    staffId: string,
    type: ShiftCommandType,
    reason?: string,
  ): PendingCommand | null {
    const policyVersionId = board?.activePolicyVersionId ?? staffView?.activePolicyVersionId;
    if (!policyVersionId) return null;
    const key = ["shift", staffId, type, reason ?? ""].join(":");
    if (retryRef.current?.key === key) return retryRef.current;
    const input: TurnIqShiftActionInput = {
      slug,
      policyVersionId,
      staffId,
      ...nextEnvelope(),
      command:
        type === "break"
          ? { type, reason: reason ?? "" }
          : { type },
    };
    retryRef.current = { key, kind: "shift", input };
    return retryRef.current;
  }

  function assignmentCommand(
    assignmentId: string,
    policyVersionId: string,
    type: "start" | "complete",
  ): PendingCommand {
    const key = ["assignment", assignmentId, type].join(":");
    if (retryRef.current?.key === key) return retryRef.current;
    const input: TurnIqAssignmentActionInput = {
      slug,
      policyVersionId,
      assignmentId,
      ...nextEnvelope(),
      command: { type },
    };
    retryRef.current = { key, kind: "assignment", input };
    return retryRef.current;
  }

  function refusalCommand(): PendingCommand | null {
    if (!refusalEditor) return null;
    const reason = refusalReason.trim();
    const key = [
      "refusal",
      refusalEditor.assignmentId,
      refusalCategory,
      reason,
    ].join(":");
    if (retryRef.current?.key === key) return retryRef.current;
    retryRef.current = {
      key,
      kind: "refusal",
      input: {
        slug,
        policyVersionId: refusalEditor.policyVersionId,
        assignmentId: refusalEditor.assignmentId,
        ...nextEnvelope(),
        command: { type: "refuse", category: refusalCategory, reason },
      },
    };
    return retryRef.current;
  }

  function redoCommand(): PendingCommand | null {
    const next = board?.nextRecommendation;
    const note = redoNote.trim();
    if (!next || !redoOriginalAssignmentId || !note) return null;
    const key = [
      "redo",
      next.assignmentId,
      redoOriginalAssignmentId,
      redoCategory,
      note,
    ].join(":");
    if (retryRef.current?.key === key) return retryRef.current;
    retryRef.current = {
      key,
      kind: "redo",
      input: {
        slug,
        policyVersionId: next.policyVersionId,
        assignmentId: next.assignmentId,
        ...nextEnvelope(),
        command: {
          type: "redo",
          originalAssignmentId: redoOriginalAssignmentId,
          category: redoCategory,
          note,
        },
      },
    };
    return retryRef.current;
  }

  function requestSwapCommand(): PendingCommand | null {
    const assignment = board?.assignments.find(
      (entry) => entry.assignmentId === swapAssignmentId,
    );
    const reason = swapReason.trim();
    if (!assignment || !swapToStaffId || !reason) return null;
    const key = ["swap", "request", assignment.assignmentId, swapToStaffId, reason].join(":");
    if (retryRef.current?.key === key) return retryRef.current;
    retryRef.current = {
      key,
      kind: "swap",
      input: {
        slug,
        policyVersionId: assignment.policyVersionId,
        ...nextEnvelope(),
        type: "request_swap",
        assignmentId: assignment.assignmentId,
        toStaffId: swapToStaffId,
        reason,
      },
    };
    return retryRef.current;
  }

  function swapDecisionCommand(
    swapId: string,
    policyVersionId: string,
    decision: "accepted" | "rejected",
  ): PendingCommand {
    const key = ["swap", "consent", swapId, decision].join(":");
    if (retryRef.current?.key === key) return retryRef.current;
    retryRef.current = {
      key,
      kind: "swap",
      input: {
        slug,
        policyVersionId,
        ...nextEnvelope(),
        type: "consent_swap",
        swapId,
        decision,
      },
    };
    return retryRef.current;
  }

  function confirmSwapCommand(
    swapId: string,
    policyVersionId: string,
  ): PendingCommand {
    const key = ["swap", "confirm", swapId].join(":");
    if (retryRef.current?.key === key) return retryRef.current;
    retryRef.current = {
      key,
      kind: "swap",
      input: {
        slug,
        policyVersionId,
        ...nextEnvelope(),
        type: "confirm_swap",
        swapId,
      },
    };
    return retryRef.current;
  }

  function correctionCommand(): PendingCommand | null {
    const assignment = board?.redoCandidates.find(
      (entry) => entry.assignmentId === correctionAssignmentId,
    );
    const reason = correctionReason.trim();
    if (!assignment || !correctionActualStaffId || !reason) {
      return null;
    }
    const key = [
      "correction",
      assignment.assignmentId,
      correctionActualStaffId,
      correctionCategory,
      reason,
    ].join(":");
    if (retryRef.current?.key === key) return retryRef.current;
    retryRef.current = {
      key,
      kind: "correction",
      input: {
        slug,
        policyVersionId: assignment.policyVersionId,
        assignmentId: assignment.assignmentId,
        actualStaffId: correctionActualStaffId,
        category: correctionCategory,
        reason,
        ...nextEnvelope(),
      },
    };
    return retryRef.current;
  }

  function createDisputeCommand(): PendingCommand | null {
    if (
      !reviewEditor ||
      (reviewEditor.kind !== "create_dispute" &&
        reviewEditor.kind !== "create_skip_dispute")
    ) return null;
    const reason = reviewReason.trim();
    if (reviewEditor.kind === "create_skip_dispute") {
      const key = [
        "create_skip_dispute",
        reviewEditor.assignmentId,
        reason,
      ].join(":");
      if (retryRef.current?.key === key) return retryRef.current;
      retryRef.current = {
        key,
        kind: "create_skip_dispute",
        input: {
          slug,
          policyVersionId: reviewEditor.policyVersionId,
          assignmentId: reviewEditor.assignmentId,
          ...nextEnvelope(),
          command: { type: "dispute", category: "skip_reason", reason },
        },
      };
      return retryRef.current;
    }
    const key = [
      "create_dispute",
      reviewEditor.receiptId,
      disputeCategory,
      reason,
    ].join(":");
    if (retryRef.current?.key === key) return retryRef.current;
    retryRef.current = {
      key,
      kind: "create_dispute",
      input: {
        slug,
        policyVersionId: reviewEditor.policyVersionId,
        fairnessReceiptId: reviewEditor.receiptId,
        ...nextEnvelope(),
        command: { type: "dispute", category: disputeCategory, reason },
      },
    };
    return retryRef.current;
  }

  function resolveReviewCommand(): PendingCommand | null {
    if (
      !reviewEditor ||
      reviewEditor.kind === "create_dispute" ||
      reviewEditor.kind === "create_skip_dispute"
    ) return null;
    const reason = reviewReason.trim();
    if (reviewEditor.kind === "resolve_dispute") {
      const key = [
        "resolve_dispute",
        reviewEditor.disputeId,
        reviewEditor.resolution,
        reason,
      ].join(":");
      if (retryRef.current?.key === key) return retryRef.current;
      retryRef.current = {
        key,
        kind: "resolve_dispute",
        input: {
          slug,
          policyVersionId: reviewEditor.policyVersionId,
          disputeId: reviewEditor.disputeId,
          ...nextEnvelope(),
          command: {
            type: "resolve_dispute",
            resolution: reviewEditor.resolution,
            reason,
          },
        },
      };
      return retryRef.current;
    }
    const key = [
      "exception",
      reviewEditor.exceptionId,
      reviewEditor.resolution,
      reason,
    ].join(":");
    if (retryRef.current?.key === key) return retryRef.current;
    retryRef.current = {
      key,
      kind: "exception",
      input: {
        slug,
        policyVersionId: reviewEditor.policyVersionId,
        exceptionId: reviewEditor.exceptionId,
        ...nextEnvelope(),
        command: { type: reviewEditor.resolution, reason },
      },
    };
    return retryRef.current;
  }

  function acknowledgeException(input: {
    id: string;
    policyVersionId: string;
  }): PendingCommand {
    const key = ["exception", input.id, "acknowledge_exception"].join(":");
    if (retryRef.current?.key === key) return retryRef.current;
    retryRef.current = {
      key,
      kind: "exception",
      input: {
        slug,
        policyVersionId: input.policyVersionId,
        exceptionId: input.id,
        ...nextEnvelope(),
        command: { type: "acknowledge_exception" },
      },
    };
    return retryRef.current;
  }

  function submit(command: PendingCommand | null) {
    if (!command) {
      setMessage(
        vi
          ? "Salon chưa có chính sách TurnIQ đang hiệu lực; không có thao tác nào được lưu."
          : "No active TurnIQ policy is available; nothing was saved.",
      );
      return;
    }
    setMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const result =
            command.kind === "shift"
              ? await onApplyShiftCommand(command.input)
              : command.kind === "assignment"
                ? await onApplyAssignmentCommand(command.input)
                : command.kind === "refusal"
                  ? await onApplyRefusalCommand(command.input)
                : command.kind === "redo"
                  ? await onApplyRedoCommand(command.input)
                : command.kind === "swap"
                  ? await onApplySwapCommand(command.input)
                : command.kind === "correction"
                  ? await onApplyCorrectionCommand(command.input)
                : command.kind === "create_dispute"
                  ? await onCreateDispute(command.input)
                  : command.kind === "create_skip_dispute"
                    ? await onCreateSkipDispute(command.input)
                  : command.kind === "resolve_dispute"
                    ? await onResolveDispute(command.input)
                    : await onApplyExceptionCommand(command.input);
          if (!result.ok) {
            setMessage(actionError(result.code, vi));
            if (result.code !== "server_error") retryRef.current = null;
            if (
              result.code === "stale_state" ||
              result.code === "policy_configuration_required"
            ) {
              try {
                await onRefresh();
              } catch {
                // Preserve the safety failure; reconnect UI owns later refresh.
              }
            }
            return;
          }
          retryRef.current = null;
          setReasonEditor(null);
          setBreakReason("");
          setReviewEditor(null);
          setReviewReason("");
          setRefusalEditor(null);
          setRefusalReason("");
          setRedoEditorOpen(false);
          setRedoOriginalAssignmentId("");
          setRedoNote("");
          setSwapEditorOpen(false);
          setSwapAssignmentId("");
          setSwapToStaffId("");
          setSwapReason("");
          setCorrectionEditorOpen(false);
          setCorrectionAssignmentId("");
          setCorrectionActualStaffId("");
          setCorrectionReason("");
          if (result.result.status === "queued_offline") {
            setMessage(
              vi
                ? "Đã lưu an toàn trên máy. Đang chờ đồng bộ; chưa báo đã gửi hoặc hoàn tất trên cloud."
                : "Saved safely on this device. Sync is pending; no cloud action is claimed complete.",
            );
            return;
          }
          setMessage(vi ? "Đã lưu an toàn. Bảng lượt đang được làm mới." : "Saved safely. The turn board is refreshing.");
          try {
            await onRefresh();
          } catch {
            // A committed command remains successful even if its read refresh fails.
          }
        } catch {
          // Keep the exact command envelope for an idempotent retry after an
          // ambiguous transport failure.
          setMessage(actionError("server_error", vi));
        }
      })();
    });
  }

  function renderShiftAction(input: {
    staffId: string;
    staffName: string;
    state: TurnIqStaffShiftState;
  }) {
    const type = shiftActionFor(input.state);
    if (!type) return null;
    if (type === "break") {
      return (
        <Button
          size="sm"
          variant="secondary"
          disabled={isPending}
          onClick={() => {
            setReasonEditor({ staffId: input.staffId, staffName: input.staffName });
            setBreakReason("");
          }}
          leftIcon={<Coffee className="size-4" />}
        >
          {vi ? "Nghỉ" : "Break"}
        </Button>
      );
    }
    const copy =
      type === "check_in"
        ? vi
          ? "Check-in"
          : "Check in"
        : type === "return"
          ? vi
            ? "Quay lại"
            : "Return"
          : vi
            ? "Bỏ tạm giữ"
            : "Release hold";
    return (
      <Button
        size="sm"
        variant={type === "check_in" ? "primary" : "secondary"}
        loading={isPending}
        onClick={() => submit(shiftCommand(input.staffId, type))}
        leftIcon={type === "check_in" ? <LogIn className="size-4" /> : <RotateCcw className="size-4" />}
      >
        {copy}
      </Button>
    );
  }

  const ownOnly = !canManageTeam && staffView;
  const assignments = canManageTeam
    ? board?.assignments ?? []
    : staffView?.currentAssignment
      ? [
          {
            ...staffView.currentAssignment,
            bookingId: null,
            recommendedStaffName: null,
            assignedStaffName: staffView.staffName,
          },
        ]
      : [];
  const swapCandidates = board?.assignments.filter(
    (assignment) =>
      assignment.status === "confirmed" && assignment.assignedStaffId !== null,
  ) ?? [];
  const selectedSwapAssignment = swapCandidates.find(
    (assignment) => assignment.assignmentId === swapAssignmentId,
  );
  const selectedCorrectionAssignment = board?.redoCandidates.find(
    (assignment) => assignment.assignmentId === correctionAssignmentId,
  );

  function downloadPilotEvidence() {
    if (!board?.pilotEvidence) return;
    const blob = new Blob([JSON.stringify(board.pilotEvidence, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `turniq-trust-summary-${board.pilotEvidence.businessDate}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const percent = (basisPoints: number | null) =>
    basisPoints === null ? "—" : `${(basisPoints / 100).toFixed(0)}%`;

  return (
    <section aria-label="TurnIQ operations" className="space-y-4">
      {board?.pilotEvidence ? (
        <Card variant="bordered" padding="md">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-nq-gold">
                {vi ? "Tổng kết tin cậy cuối ca" : "End-of-shift trust summary"}
              </p>
              <h3 className="mt-1 text-lg font-semibold text-nq-text">
                {board.pilotEvidence.businessDate}
              </h3>
              <p className="mt-1 text-sm text-nq-muted">
                {vi ? "Số liệu quan sát; mục tiêu pilot vẫn là giả thuyết cho đến khi thử tại salon thật." : "Observed evidence; pilot targets remain hypotheses until a real salon trial."}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={downloadPilotEvidence} leftIcon={<Download className="size-4" />}>
              {vi ? "Xuất bằng chứng" : "Export evidence"}
            </Button>
          </div>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-nq-border/70 p-3"><dt className="text-xs text-nq-muted">{vi ? "Khách hoàn tất" : "Completed"}</dt><dd className="mt-1 text-xl font-bold">{board.pilotEvidence.completedCustomers}</dd></div>
            <div className="rounded-2xl border border-nq-border/70 p-3"><dt className="text-xs text-nq-muted">{vi ? "Nhận đề xuất" : "Acceptance"}</dt><dd className="mt-1 text-xl font-bold">{percent(board.pilotEvidence.recommendationAcceptanceBasisPoints)}</dd></div>
            <div className="rounded-2xl border border-nq-border/70 p-3"><dt className="text-xs text-nq-muted">{vi ? "Không cần Owner" : "Without Owner"}</dt><dd className="mt-1 text-xl font-bold">{percent(board.pilotEvidence.normalTurnsWithoutOwnerBasisPoints)}</dd></div>
            <div className="rounded-2xl border border-nq-border/70 p-3"><dt className="text-xs text-nq-muted">{vi ? "Chờ p50 / p90" : "Wait p50 / p90"}</dt><dd className="mt-1 text-xl font-bold">{board.pilotEvidence.waitP50Minutes ?? "—"} / {board.pilotEvidence.waitP90Minutes ?? "—"} min</dd></div>
          </dl>
          <p className="mt-3 text-sm text-nq-muted">
            {vi
              ? `${board.pilotEvidence.overrides} override · ${percent(board.pilotEvidence.walkawayRateBasisPoints)} walk-away (proxy) · ${Math.ceil(board.pilotEvidence.ownerDecisionSecondsObserved / 60)} phút Owner quan sát được · ${board.pilotEvidence.unresolvedExceptions} ngoại lệ mở · ${board.pilotEvidence.unresolvedDisputes} tranh chấp mở · ${board.pilotEvidence.unresolvedOfflineConflicts} xung đột offline`
              : `${board.pilotEvidence.overrides} override(s) · ${percent(board.pilotEvidence.walkawayRateBasisPoints)} walk-away proxy · ${Math.ceil(board.pilotEvidence.ownerDecisionSecondsObserved / 60)} observed Owner minute(s) · ${board.pilotEvidence.unresolvedExceptions} open exception(s) · ${board.pilotEvidence.unresolvedDisputes} open dispute(s) · ${board.pilotEvidence.unresolvedOfflineConflicts} offline conflict(s)`}
          </p>
          {!board.pilotEvidence.offlineLossEvidenceComplete ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              {vi ? "Chưa thể chứng minh không mất lệnh offline chỉ từ dữ liệu máy chủ; phải hoàn tất kiểm tra thiết bị và đối soát pilot." : "Server data alone cannot prove zero lost offline commands; device and pilot reconciliation evidence is still required."}
            </p>
          ) : null}
        </Card>
      ) : null}
      {canManageTeam ? (
        <Card variant="bordered" padding="md" className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium text-nq-text">{vi ? "QR khách check-in" : "Customer check-in QR"}</p>
            <p className="mt-1 text-sm text-nq-muted">
              {vi ? "Phát QR ngắn hạn; chỉ ghi nhận shadow, chưa đổi lịch hoặc lượt." : "Issue a short-lived QR; shadow receipt only, with no booking or turn change."}
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<QrCode className="size-4" />}
            onClick={() => window.open(`/dashboard/${encodeURIComponent(slug)}/turniq/check-in`, "_blank", "noopener,noreferrer")}
          >
            {vi ? "Mở QR" : "Open QR"}
          </Button>
        </Card>
      ) : null}
      {canManageTeam && board ? (
        <Card variant="bordered" padding="md">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Users aria-hidden="true" className="size-5 text-nq-gold" />
              <h3 className="font-semibold text-nq-text">
                {vi ? "Đội ngũ hôm nay" : "Today's team"}
              </h3>
            </div>
            <span className="text-xs text-nq-muted">
              {vi ? "Check-in theo thứ tự" : "Check-in order"}
            </span>
          </div>
          <ul className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {board.staff.map((staff) => {
              const badge = SHIFT_BADGE[staff.state];
              return (
                <li
                  key={staff.staffId}
                  className="flex min-h-16 items-center justify-between gap-3 rounded-2xl border border-nq-border/70 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-nq-text">{staff.staffName}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge size="sm" variant={badge.variant} state="subtle">
                        {badge[language]}
                      </Badge>
                      {staff.queuePosition ? (
                        <span className="text-xs text-nq-muted">
                          {vi ? `Lượt #${staff.queuePosition}` : `Turn #${staff.queuePosition}`} · {staff.turnsConsumed}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {renderShiftAction(staff)}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {ownOnly ? (
        <Card variant="bordered" padding="md">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-nq-gold">
                {vi ? "Lượt của tôi" : "My turn"}
              </p>
              <h3 className="mt-1 text-lg font-semibold text-nq-text">
                {staffView.staffName}
              </h3>
              <p className="mt-1 text-sm text-nq-muted">
                {staffView.queuePosition
                  ? vi
                    ? `Vị trí ${staffView.queuePosition} · ${staffView.turnsConsumed} lượt đã hoàn tất`
                    : `Position ${staffView.queuePosition} · ${staffView.turnsConsumed} completed turn(s)`
                  : vi
                    ? "Chưa vào hàng lượt hôm nay"
                    : "Not in today's turn queue"}
              </p>
              <p className="mt-2 text-sm text-nq-muted">
                {vi
                  ? `Credit cơ hội của tôi: ${(staffView.ownOpportunityCreditCents / 100).toFixed(2)} · ${staffView.whyNotMe.length} lần bỏ qua có giải thích · ${staffView.recentReceipts.filter((receipt) => receipt.dispute && receipt.dispute.status !== "resolved" && receipt.dispute.status !== "dismissed").length} tranh chấp chưa xong`
                  : `My opportunity credit: ${(staffView.ownOpportunityCreditCents / 100).toFixed(2)} · ${staffView.whyNotMe.length} explained skip(s) · ${staffView.recentReceipts.filter((receipt) => receipt.dispute && receipt.dispute.status !== "resolved" && receipt.dispute.status !== "dismissed").length} unresolved dispute(s)`}
              </p>
            </div>
            {renderShiftAction({
              staffId: staffView.staffId,
              staffName: staffView.staffName,
              state: staffView.shiftState,
            })}
          </div>
        </Card>
      ) : null}

      {canManageTeam && board?.nextRecommendation ? (
        <Card variant="bordered" padding="md">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-nq-gold">
                {vi ? "Nếu lượt không được nhận" : "If the turn is not accepted"}
              </p>
              <p className="mt-1 font-medium text-nq-text">
                {board.nextRecommendation.recommendedStaffName}
                {board.nextRecommendation.serviceName
                  ? ` · ${board.nextRecommendation.serviceName}`
                  : ""}
              </p>
              <p className="mt-1 text-sm text-nq-muted">
                {vi
                  ? "Chọn đúng nguyên nhân để TurnIQ không phạt nhầm hoặc đổi lượt âm thầm."
                  : "Classify the reason so TurnIQ never penalizes or changes the queue silently."}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={isPending}
              leftIcon={<UserX className="size-4" />}
              onClick={() => {
                setRefusalEditor({
                  assignmentId: board.nextRecommendation!.assignmentId,
                  policyVersionId: board.nextRecommendation!.policyVersionId,
                  staffName: board.nextRecommendation!.recommendedStaffName,
                });
                setRefusalCategory("customer_declined");
                setRefusalReason("");
              }}
            >
              {vi ? "Ghi nhận không nhận lượt" : "Record not accepted"}
            </Button>
          </div>
        </Card>
      ) : null}

      {canManageTeam && board?.nextRecommendation ? (
        <Card variant="bordered" padding="md">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-nq-gold">
                {vi ? "Redo / sửa lại" : "Redo / repair"}
              </p>
              <p className="mt-1 font-medium text-nq-text">
                {board.nextRecommendation.serviceName ??
                  (vi ? "Lượt dịch vụ kế tiếp" : "Next service turn")}
              </p>
              <p className="mt-1 text-sm text-nq-muted">
                {vi
                  ? "Liên kết với lượt gốc; TurnIQ tự lấy quy tắc lượt và credit của salon."
                  : "Link the original service; TurnIQ derives turn and credit outcomes from the salon policy."}
              </p>
            </div>
            {board.nextRecommendation.redo ? (
              <Badge size="sm" variant="success" state="subtle">
                {vi ? "Đã phân loại" : "Classified"}
              </Badge>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={isPending || board.redoCandidates.length === 0}
                leftIcon={<Wrench className="size-4" />}
                onClick={() => {
                  setRedoEditorOpen(true);
                  setRedoOriginalAssignmentId(
                    board.redoCandidates[0]?.assignmentId ?? "",
                  );
                  setRedoCategory("quality_issue");
                  setRedoNote("");
                }}
              >
                {vi ? "Đánh dấu redo" : "Mark as redo"}
              </Button>
            )}
          </div>
          {board.nextRecommendation.redo ? (
            <div className="mt-3 rounded-2xl border border-nq-success/30 bg-nq-success/10 p-3 text-sm">
              <p className="font-medium text-nq-text">
                {board.nextRecommendation.redo.consumesTurn
                  ? vi ? "Có tính một lượt" : "Consumes one turn"
                  : vi ? "Không tính lượt" : "Does not consume a turn"}
                {" · "}
                {board.nextRecommendation.redo.creditsOpportunity
                  ? vi ? "Có tính credit cơ hội" : "Credits opportunity"
                  : vi ? "Không tính credit cơ hội" : "No opportunity credit"}
              </p>
              <p className="mt-1 text-nq-muted">
                {board.nextRecommendation.redo.note}
              </p>
            </div>
          ) : board.redoCandidates.length === 0 ? (
            <p className="mt-3 text-sm text-nq-muted">
              {vi
                ? "Chưa có lượt TurnIQ đã hoàn tất trong 31 ngày để liên kết."
                : "No completed TurnIQ assignment from the last 31 days is available to link."}
            </p>
          ) : null}
        </Card>
      ) : null}

      {redoEditorOpen && board?.nextRecommendation ? (
        <Card
          variant="bordered"
          padding="md"
          className="border-nq-warning/40 bg-nq-warning/10"
        >
          <h3 className="font-semibold text-nq-text">
            {vi ? "Phân loại redo trước khi xác nhận" : "Classify redo before confirmation"}
          </h3>
          <label className="mt-3 block text-sm font-medium text-nq-text">
            {vi ? "Lượt gốc đã hoàn tất" : "Completed original turn"}
            <select
              className="mt-2 min-h-11 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 text-base text-nq-text outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/40"
              value={redoOriginalAssignmentId}
              onChange={(event) => setRedoOriginalAssignmentId(event.target.value)}
            >
              {board.redoCandidates.map((candidate) => (
                <option key={candidate.assignmentId} value={candidate.assignmentId}>
                  {candidate.completedAt.slice(0, 10)} · {candidate.assignedStaffName} · {candidate.serviceName ?? (vi ? "Dịch vụ" : "Service")}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 block text-sm font-medium text-nq-text">
            {vi ? "Loại redo" : "Redo category"}
            <select
              className="mt-2 min-h-11 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 text-base text-nq-text outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/40"
              value={redoCategory}
              onChange={(event) =>
                setRedoCategory(
                  event.target.value as TurnIqRedoActionInput["command"]["category"],
                )
              }
            >
              <option value="quality_issue">
                {vi ? "Chất lượng salon/thợ" : "Salon/technician quality issue"}
              </option>
              <option value="customer_damage_or_change">
                {vi ? "Khách làm hư hoặc đổi ý" : "Customer damage or change of mind"}
              </option>
              <option value="warranty_or_goodwill">
                {vi ? "Bảo hành hoặc thiện chí quản lý" : "Warranty or manager goodwill"}
              </option>
              <option value="other">{vi ? "Khác" : "Other"}</option>
            </select>
          </label>
          <label className="mt-3 block text-sm font-medium text-nq-text">
            {vi ? "Ghi chú bắt buộc" : "Required note"}
            <textarea
              autoFocus
              className="mt-2 min-h-24 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 py-3 text-base text-nq-text outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/40"
              maxLength={500}
              value={redoNote}
              onChange={(event) => setRedoNote(event.target.value)}
              placeholder={vi ? "Mô tả ngắn điều cần sửa" : "Briefly describe what needs repair"}
            />
          </label>
          <p className="mt-2 text-xs text-nq-muted">
            {vi
              ? "Bạn chỉ chọn sự thật. TurnIQ quyết định tính lượt/credit từ policy; không thay đổi receipt gốc."
              : "You select the facts only. TurnIQ derives turn/credit from policy and never rewrites the original receipt."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              loading={isPending}
              disabled={!redoOriginalAssignmentId || !redoNote.trim()}
              onClick={() => submit(redoCommand())}
            >
              {vi ? "Lưu phân loại" : "Save classification"}
            </Button>
            <Button
              variant="ghost"
              disabled={isPending}
              onClick={() => setRedoEditorOpen(false)}
            >
              {vi ? "Đóng" : "Close"}
            </Button>
          </div>
        </Card>
      ) : null}

      {canManageTeam && board ? (
        <Card variant="bordered" padding="md">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-nq-gold">
                {vi ? "Đổi thợ có đồng thuận" : "Consented technician swap"}
              </p>
              <p className="mt-1 text-sm text-nq-muted">
                {vi
                  ? "Chỉ đổi trước khi bắt đầu. Hai thợ tự đồng ý; Front Desk xác nhận một chạm."
                  : "Pre-service only. Both technicians consent for themselves; Front Desk applies it in one tap."}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={isPending || swapCandidates.length === 0}
              leftIcon={<ArrowRightLeft className="size-4" />}
              onClick={() => {
                const first = swapCandidates[0];
                setSwapEditorOpen(true);
                setSwapAssignmentId(first?.assignmentId ?? "");
                setSwapToStaffId(
                  board.staff.find(
                    (staff) =>
                      staff.state === "active" &&
                      staff.staffId !== first?.assignedStaffId,
                  )?.staffId ?? "",
                );
                setSwapReason("");
              }}
            >
              {vi ? "Đề nghị đổi" : "Propose swap"}
            </Button>
          </div>
          {swapCandidates.length === 0 ? (
            <p className="mt-3 text-sm text-nq-muted">
              {vi
                ? "Không có lượt đã xác nhận và chưa bắt đầu để đổi."
                : "No confirmed, not-yet-started assignment is available to swap."}
            </p>
          ) : null}
          {board.swaps.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {board.swaps.map((swap) => (
                <li key={swap.id} className="rounded-2xl border border-nq-border/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-nq-text">
                        {swap.fromStaffName} → {swap.toStaffName}
                      </p>
                      <p className="mt-1 text-sm text-nq-muted">{swap.reason}</p>
                      <p className="mt-1 text-xs text-nq-muted">
                        {vi
                          ? `${swap.consentCount}/2 thợ đã đồng ý`
                          : `${swap.consentCount}/2 technicians consented`}
                      </p>
                    </div>
                    {swap.status === "ready" ? (
                      <Button
                        size="sm"
                        loading={isPending}
                        onClick={() => submit(confirmSwapCommand(swap.id, swap.policyVersionId))}
                      >
                        {vi ? "Xác nhận đổi" : "Apply swap"}
                      </Button>
                    ) : (
                      <Badge size="sm" variant="warning" state="subtle">
                        {vi ? "Chờ đồng ý" : "Awaiting consent"}
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {swapEditorOpen && board ? (
        <Card variant="bordered" padding="md" className="border-nq-warning/40 bg-nq-warning/10">
          <h3 className="font-semibold text-nq-text">
            {vi ? "Đề nghị đổi thợ trước dịch vụ" : "Propose a pre-service swap"}
          </h3>
          <label className="mt-3 block text-sm font-medium text-nq-text">
            {vi ? "Lượt đã xác nhận" : "Confirmed assignment"}
            <select
              className="mt-2 min-h-11 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 text-base text-nq-text"
              value={swapAssignmentId}
              onChange={(event) => setSwapAssignmentId(event.target.value)}
            >
              {swapCandidates.map((assignment) => (
                <option key={assignment.assignmentId} value={assignment.assignmentId}>
                  {assignment.assignedStaffName ?? (vi ? "Thợ" : "Technician")} · {assignment.serviceName ?? (vi ? "Dịch vụ" : "Service")}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 block text-sm font-medium text-nq-text">
            {vi ? "Đổi sang thợ" : "Transfer to"}
            <select
              className="mt-2 min-h-11 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 text-base text-nq-text"
              value={swapToStaffId}
              onChange={(event) => setSwapToStaffId(event.target.value)}
            >
              <option value="">{vi ? "Chọn thợ đang sẵn sàng" : "Choose an active technician"}</option>
              {board.staff
                .filter(
                  (staff) =>
                    staff.state === "active" &&
                    staff.staffId !== selectedSwapAssignment?.assignedStaffId,
                )
                .map((staff) => (
                  <option key={staff.staffId} value={staff.staffId}>{staff.staffName}</option>
                ))}
            </select>
          </label>
          <label className="mt-3 block text-sm font-medium text-nq-text">
            {vi ? "Lý do hiển thị cho hai thợ" : "Reason visible to both technicians"}
            <textarea
              className="mt-2 min-h-24 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 py-3 text-base text-nq-text"
              maxLength={500}
              value={swapReason}
              onChange={(event) => setSwapReason(event.target.value)}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              loading={isPending}
              disabled={!swapAssignmentId || !swapToStaffId || !swapReason.trim()}
              onClick={() => submit(requestSwapCommand())}
            >
              {vi ? "Gửi cho hai thợ đồng ý" : "Request both consents"}
            </Button>
            <Button variant="ghost" disabled={isPending} onClick={() => setSwapEditorOpen(false)}>
              {vi ? "Đóng" : "Close"}
            </Button>
          </div>
        </Card>
      ) : null}

      {staffView && staffView.pendingSwaps.length > 0 ? (
        <Card variant="bordered" padding="md" className="border-nq-warning/40">
          <h3 className="font-semibold text-nq-text">
            {vi ? "Yêu cầu đổi thợ của tôi" : "My swap consent"}
          </h3>
          <ul className="mt-3 space-y-2">
            {staffView.pendingSwaps.map((swap) => (
              <li key={swap.id} className="rounded-2xl border border-nq-border/70 p-3">
                <p className="font-medium text-nq-text">
                  {swap.fromStaffName} → {swap.toStaffName}
                </p>
                <p className="mt-1 text-sm text-nq-muted">{swap.reason}</p>
                {swap.ownDecision ? (
                  <Badge className="mt-2" size="sm" variant="success" state="subtle">
                    {vi ? "Bạn đã đồng ý" : "You consented"}
                  </Badge>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      loading={isPending}
                      onClick={() => submit(swapDecisionCommand(swap.id, swap.policyVersionId, "accepted"))}
                    >
                      {vi ? "Tôi đồng ý" : "I consent"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={isPending}
                      onClick={() => submit(swapDecisionCommand(swap.id, swap.policyVersionId, "rejected"))}
                    >
                      {vi ? "Không đồng ý" : "Decline"}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {canCorrectRecords && board ? (
        <Card variant="bordered" padding="md">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-nq-gold">
                {vi ? "Sửa người thực sự làm" : "Correct actual performer"}
              </p>
              <p className="mt-1 text-sm text-nq-muted">
                {vi
                  ? "Chỉ Owner/Admin. Receipt gốc giữ nguyên; TurnIQ chuyển đúng lượt/credit và ghi lịch sử."
                  : "Owner/Admin only. The original receipt stays intact while turn/credit and correction history are updated."}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={isPending || board.redoCandidates.length === 0}
              onClick={() => {
                const first = board.redoCandidates[0];
                setCorrectionEditorOpen(true);
                setCorrectionAssignmentId(first?.assignmentId ?? "");
                setCorrectionActualStaffId(
                  board.staff.find(
                    (staff) => staff.staffId !== first?.assignedStaffId,
                  )?.staffId ?? "",
                );
                setCorrectionCategory("wrong_technician");
                setCorrectionReason("");
              }}
            >
              {vi ? "Ghi hiệu chỉnh" : "Record correction"}
            </Button>
          </div>
          {board.recentCorrections.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {board.recentCorrections.map((correction) => (
                <li key={correction.id} className="rounded-2xl border border-nq-border/70 p-3 text-sm">
                  <p className="font-medium text-nq-text">
                    {correction.previousStaffName} → {correction.actualStaffName}
                  </p>
                  <p className="mt-1 text-nq-muted">{correction.reason}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {correctionEditorOpen && canCorrectRecords && board ? (
        <Card variant="bordered" padding="md" className="border-nq-warning/40 bg-nq-warning/10">
          <h3 className="font-semibold text-nq-text">
            {vi ? "Hiệu chỉnh bản ghi đã hoàn tất" : "Correct a completed record"}
          </h3>
          <label className="mt-3 block text-sm font-medium text-nq-text">
            {vi ? "Lượt đã hoàn tất" : "Completed assignment"}
            <select
              className="mt-2 min-h-11 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 text-base text-nq-text"
              value={correctionAssignmentId}
              onChange={(event) => setCorrectionAssignmentId(event.target.value)}
            >
              {board.redoCandidates.map((assignment) => (
                <option key={assignment.assignmentId} value={assignment.assignmentId}>
                  {assignment.completedAt.slice(0, 10)} · {assignment.assignedStaffName} · {assignment.serviceName ?? (vi ? "Dịch vụ" : "Service")}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 block text-sm font-medium text-nq-text">
            {vi ? "Thợ thực sự làm" : "Actual technician"}
            <select
              className="mt-2 min-h-11 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 text-base text-nq-text"
              value={correctionActualStaffId}
              onChange={(event) => setCorrectionActualStaffId(event.target.value)}
            >
              <option value="">{vi ? "Chọn thợ" : "Choose technician"}</option>
              {board.staff
                .filter((staff) => staff.staffId !== selectedCorrectionAssignment?.assignedStaffId)
                .map((staff) => (
                  <option key={staff.staffId} value={staff.staffId}>{staff.staffName}</option>
                ))}
            </select>
          </label>
          <label className="mt-3 block text-sm font-medium text-nq-text">
            {vi ? "Loại sai lệch" : "Correction category"}
            <select
              className="mt-2 min-h-11 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 text-base text-nq-text"
              value={correctionCategory}
              onChange={(event) => setCorrectionCategory(event.target.value as TurnIqCorrectionActionInput["category"])}
            >
              <option value="wrong_technician">{vi ? "Ghi nhầm thợ" : "Wrong technician"}</option>
              <option value="missed_handoff">{vi ? "Bỏ sót bàn giao" : "Missed handoff"}</option>
              <option value="administrative_error">{vi ? "Lỗi hành chính" : "Administrative error"}</option>
              <option value="other">{vi ? "Khác" : "Other"}</option>
            </select>
          </label>
          <label className="mt-3 block text-sm font-medium text-nq-text">
            {vi ? "Lý do bắt buộc" : "Required reason"}
            <textarea
              className="mt-2 min-h-24 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 py-3 text-base text-nq-text"
              maxLength={500}
              value={correctionReason}
              onChange={(event) => setCorrectionReason(event.target.value)}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              loading={isPending}
              disabled={!correctionAssignmentId || !correctionActualStaffId || !correctionReason.trim()}
              onClick={() => submit(correctionCommand())}
            >
              {vi ? "Chuyển lượt/credit và lưu lịch sử" : "Move turn/credit and record history"}
            </Button>
            <Button variant="ghost" disabled={isPending} onClick={() => setCorrectionEditorOpen(false)}>
              {vi ? "Đóng" : "Close"}
            </Button>
          </div>
        </Card>
      ) : null}

      {staffView && staffView.recentCorrections.length > 0 ? (
        <Card variant="bordered" padding="md">
          <h3 className="font-semibold text-nq-text">
            {vi ? "Hiệu chỉnh liên quan đến tôi" : "Corrections involving me"}
          </h3>
          <ul className="mt-3 space-y-2">
            {staffView.recentCorrections.map((correction) => (
              <li key={correction.id} className="rounded-2xl border border-nq-border/70 p-3 text-sm">
                <p className="font-medium text-nq-text">
                  {correction.direction === "moved_to_me"
                    ? vi ? "Lượt được chuyển đúng về bạn" : "Turn corrected to you"
                    : vi ? "Lượt được chuyển khỏi bạn" : "Turn corrected away from you"}
                </p>
                <p className="mt-1 text-nq-muted">{correction.reason}</p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {refusalEditor ? (
        <Card
          variant="bordered"
          padding="md"
          className="border-nq-warning/40 bg-nq-warning/10"
        >
          <h3 className="font-semibold text-nq-text">
            {vi
              ? `Vì sao ${refusalEditor.staffName} không nhận lượt?`
              : `Why was ${refusalEditor.staffName}'s turn not accepted?`}
          </h3>
          <label className="mt-3 block text-sm font-medium text-nq-text">
            {vi ? "Nguyên nhân" : "Reason type"}
            <select
              className="mt-2 min-h-11 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 text-base text-nq-text outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/40"
              value={refusalCategory}
              onChange={(event) =>
                setRefusalCategory(
                  event.target.value as TurnIqRefusalActionInput["command"]["category"],
                )
              }
            >
              <option value="customer_declined">
                {vi ? "Khách không chọn thợ được đề xuất — không phạt" : "Customer declined recommendation — no penalty"}
              </option>
              <option value="illness_emergency">
                {vi ? "Bệnh/khẩn cấp đã duyệt — giữ vị trí, tạm dừng" : "Approved illness/emergency — hold position"}
              </option>
              <option value="unapproved_refusal">
                {vi ? "Thợ từ chối không lý do duyệt — xuống cuối hàng" : "Unapproved technician refusal — move to queue end"}
              </option>
            </select>
          </label>
          <label className="mt-3 block text-sm font-medium text-nq-text">
            {vi ? "Ghi rõ lý do" : "Required note"}
            <textarea
              autoFocus
              className="mt-2 min-h-24 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 py-3 text-base text-nq-text outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/40"
              maxLength={500}
              value={refusalReason}
              onChange={(event) => setRefusalReason(event.target.value)}
            />
          </label>
          <p className="mt-2 text-xs text-nq-muted">
            {refusalCategory === "unapproved_refusal"
              ? vi
                ? "Kết quả: thợ xuống cuối hàng lượt; booking không tự đổi và không tự gửi thông báo."
                : "Outcome: technician moves to the queue end; booking and notifications do not change automatically."
              : refusalCategory === "illness_emergency"
                ? vi
                  ? "Kết quả: giữ nguyên vị trí và đưa thợ vào tạm dừng an toàn."
                  : "Outcome: preserve queue position and place the technician on a safe hold."
                : vi
                  ? "Kết quả: không phạt thợ; booking không tự đổi."
                  : "Outcome: no technician penalty; booking does not change automatically."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              loading={isPending}
              disabled={!refusalReason.trim()}
              onClick={() => submit(refusalCommand())}
            >
              {vi ? "Xác nhận và ghi lịch sử" : "Confirm and record"}
            </Button>
            <Button
              variant="ghost"
              disabled={isPending}
              onClick={() => setRefusalEditor(null)}
            >
              {vi ? "Đóng" : "Close"}
            </Button>
          </div>
        </Card>
      ) : null}

      {staffView && staffView.recentReceipts.length > 0 ? (
        <Card variant="bordered" padding="md">
          <h3 className="font-semibold text-nq-text">
            {vi ? "Biên nhận công bằng của tôi" : "My Fairness Receipts"}
          </h3>
          <p className="mt-1 text-sm text-nq-muted">
            {vi
              ? "Nếu có điều chưa đúng, gửi một yêu cầu xem lại mà không thấy tiền của người khác."
              : "Flag a concern without seeing anyone else's financial details."}
          </p>
          <ul className="mt-3 space-y-2">
            {staffView.recentReceipts.map((receipt) => {
              const activeDispute =
                receipt.dispute?.status === "open" ||
                receipt.dispute?.status === "under_review";
              return (
                <li
                  key={receipt.id}
                  className="rounded-2xl border border-nq-border/70 p-3"
                >
                  <p className="text-sm text-nq-text">{receipt.explanation}</p>
                  {receipt.dispute ? (
                    <div className="mt-2 rounded-xl bg-nq-surface px-3 py-2 text-sm">
                      <Badge
                        size="sm"
                        variant={activeDispute ? "warning" : "neutral"}
                        state="subtle"
                      >
                        {activeDispute
                          ? vi
                            ? "Đang được xem lại"
                            : "Under review"
                          : receipt.dispute.status === "resolved"
                            ? vi
                              ? "Đã giải quyết"
                              : "Resolved"
                            : vi
                              ? "Đã đóng"
                              : "Dismissed"}
                      </Badge>
                      <p className="mt-2 text-nq-muted">{receipt.dispute.reason}</p>
                      {receipt.dispute.resolutionReason ? (
                        <p className="mt-1 text-nq-text">
                          <strong>{vi ? "Kết quả:" : "Outcome:"}</strong>{" "}
                          {receipt.dispute.resolutionReason}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {!activeDispute ? (
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="secondary"
                      disabled={isPending}
                      onClick={() => {
                        setReviewEditor({
                          kind: "create_dispute",
                          receiptId: receipt.id,
                          policyVersionId: receipt.policyVersionId,
                        });
                        setDisputeCategory("assignment");
                        setReviewReason("");
                      }}
                    >
                      {vi ? "Yêu cầu xem lại" : "Flag for review"}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {staffView && staffView.recentRefusals.length > 0 ? (
        <Card variant="bordered" padding="md">
          <h3 className="font-semibold text-nq-text">
            {vi ? "Lịch sử lượt không được nhận" : "Turns not accepted"}
          </h3>
          <p className="mt-1 text-sm text-nq-muted">
            {vi
              ? "Bạn thấy lý do và kết quả của chính mình; TurnIQ không hiển thị tiền hoặc dữ liệu riêng của đồng nghiệp."
              : "You see your own reason and outcome; TurnIQ does not expose coworker money or private data."}
          </p>
          <ul className="mt-3 space-y-2">
            {staffView.recentRefusals.map((entry) => (
              <li
                key={entry.assignmentId}
                className="rounded-2xl border border-nq-border/70 p-3"
              >
                <p className="font-medium text-nq-text">
                  {entry.serviceName ?? (vi ? "Lượt dịch vụ" : "Service turn")}
                </p>
                <Badge
                  className="mt-2"
                  size="sm"
                  variant={
                    entry.outcome === "moved_to_queue_end" ? "warning" : "neutral"
                  }
                  state="subtle"
                >
                  {entry.outcome === "moved_to_queue_end"
                    ? vi
                      ? "Đã xuống cuối hàng"
                      : "Moved to queue end"
                    : entry.outcome === "no_penalty_temporary_hold"
                      ? vi
                        ? "Không phạt · giữ vị trí và tạm dừng"
                        : "No penalty · position held"
                      : vi
                        ? "Không phạt"
                        : "No penalty"}
                </Badge>
                <p className="mt-2 text-sm text-nq-muted">{entry.reason}</p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {staffView && staffView.recentRedos.length > 0 ? (
        <Card variant="bordered" padding="md">
          <h3 className="font-semibold text-nq-text">
            {vi ? "Redo / sửa lại của tôi" : "My redo / repair work"}
          </h3>
          <p className="mt-1 text-sm text-nq-muted">
            {vi
              ? "Kết quả lượt và credit đã được lấy từ policy của salon, không từ người nhập."
              : "Turn and credit outcomes come from salon policy, not from the person entering the redo."}
          </p>
          <ul className="mt-3 space-y-2">
            {staffView.recentRedos.map((entry) => (
              <li
                key={entry.assignmentId}
                className="rounded-2xl border border-nq-border/70 p-3"
              >
                <p className="font-medium text-nq-text">
                  {entry.serviceName ?? (vi ? "Dịch vụ sửa lại" : "Repair service")}
                </p>
                <p className="mt-1 text-sm text-nq-muted">{entry.note}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge size="sm" variant="neutral" state="subtle">
                    {entry.consumesTurn
                      ? vi ? "Có tính lượt" : "Turn counted"
                      : vi ? "Không tính lượt" : "No turn"}
                  </Badge>
                  <Badge size="sm" variant="neutral" state="subtle">
                    {entry.creditsOpportunity
                      ? vi ? "Có credit cơ hội" : "Opportunity credited"
                      : vi ? "Không credit cơ hội" : "No opportunity credit"}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {staffView && staffView.whyNotMe.length > 0 ? (
        <Card variant="bordered" padding="md">
          <h3 className="font-semibold text-nq-text">
            {vi ? "Tại sao không phải tôi?" : "Why not me?"}
          </h3>
          <p className="mt-1 text-sm text-nq-muted">
            {vi
              ? "TurnIQ chỉ hiển thị lý do của bạn, không hiển thị tiền hoặc dữ liệu riêng của đồng nghiệp."
              : "TurnIQ shows only your reason, never a coworker's money or private details."}
          </p>
          <ul className="mt-3 space-y-2">
            {staffView.whyNotMe.map((entry) => {
              const activeDispute =
                entry.dispute?.status === "open" ||
                entry.dispute?.status === "under_review";
              return (
                <li
                  key={entry.assignmentId}
                  className="rounded-2xl border border-nq-border/70 p-3"
                >
                  <p className="font-medium text-nq-text">
                    {entry.serviceName ?? (vi ? "Quyết định phân công" : "Assignment decision")}
                  </p>
                  <p className="mt-1 text-sm text-nq-muted">{entry.explanation}</p>
                  {entry.dispute ? (
                    <div className="mt-2 rounded-xl bg-nq-surface px-3 py-2 text-sm">
                      <Badge
                        size="sm"
                        variant={activeDispute ? "warning" : "neutral"}
                        state="subtle"
                      >
                        {activeDispute
                          ? vi ? "Đang được xem lại" : "Under review"
                          : entry.dispute.status === "resolved"
                            ? vi ? "Đã giải quyết" : "Resolved"
                            : vi ? "Đã đóng" : "Dismissed"}
                      </Badge>
                      <p className="mt-2 text-nq-muted">{entry.dispute.reason}</p>
                      {entry.dispute.resolutionReason ? (
                        <p className="mt-1 text-nq-text">
                          <strong>{vi ? "Kết quả:" : "Outcome:"}</strong>{" "}
                          {entry.dispute.resolutionReason}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {!entry.dispute ? (
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="secondary"
                      disabled={isPending}
                      onClick={() => {
                        setReviewEditor({
                          kind: "create_skip_dispute",
                          assignmentId: entry.assignmentId,
                          policyVersionId: entry.policyVersionId,
                        });
                        setReviewReason("");
                      }}
                    >
                      {vi ? "Yêu cầu xem lại lý do" : "Request reason review"}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {reasonEditor ? (
        <Card variant="bordered" padding="md" className="border-nq-warning/40 bg-nq-warning/10">
          <label className="block text-sm font-medium text-nq-text">
            {vi ? `Lý do nghỉ của ${reasonEditor.staffName}` : `Break reason for ${reasonEditor.staffName}`}
            <textarea
              autoFocus
              className="mt-2 min-h-24 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 py-3 text-base text-nq-text outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/40"
              maxLength={500}
              value={breakReason}
              onChange={(event) => setBreakReason(event.target.value)}
              placeholder={vi ? "Ví dụ: nghỉ trưa đã duyệt" : "Example: approved lunch break"}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              loading={isPending}
              disabled={!breakReason.trim()}
              onClick={() =>
                submit(
                  shiftCommand(reasonEditor.staffId, "break", breakReason.trim()),
                )
              }
            >
              {vi ? "Bắt đầu nghỉ" : "Start break"}
            </Button>
            <Button
              variant="ghost"
              disabled={isPending}
              onClick={() => setReasonEditor(null)}
            >
              {vi ? "Đóng" : "Close"}
            </Button>
          </div>
        </Card>
      ) : null}

      {assignments.some(
        (assignment) => assignment.status === "confirmed" || assignment.status === "in_progress",
      ) ? (
        <Card variant="bordered" padding="md">
          <h3 className="font-semibold text-nq-text">
            {vi ? "Dịch vụ đang hoạt động" : "Active services"}
          </h3>
          <ul className="mt-3 space-y-2">
            {assignments
              .filter(
                (assignment) =>
                  assignment.status === "confirmed" || assignment.status === "in_progress",
              )
              .map((assignment) => {
                const commandType = assignment.status === "confirmed" ? "start" : "complete";
                return (
                  <li
                    key={assignment.assignmentId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-nq-border/70 px-3 py-3"
                  >
                    <div>
                      <p className="font-medium text-nq-text">
                        {assignment.serviceName ?? (vi ? "Dịch vụ" : "Service")}
                      </p>
                      {"assignedStaffName" in assignment && assignment.assignedStaffName ? (
                        <p className="text-sm text-nq-muted">{assignment.assignedStaffName}</p>
                      ) : null}
                    </div>
                    <Button
                      loading={isPending}
                      onClick={() =>
                        submit(
                          assignmentCommand(
                            assignment.assignmentId,
                            assignment.policyVersionId,
                            commandType,
                          ),
                        )
                      }
                      leftIcon={
                        commandType === "start" ? (
                          <Play className="size-4" />
                        ) : (
                          <Square className="size-4" />
                        )
                      }
                    >
                      {commandType === "start"
                        ? vi
                          ? "Bắt đầu"
                          : "Start"
                        : vi
                          ? "Hoàn tất"
                          : "Complete"}
                    </Button>
                  </li>
                );
              })}
          </ul>
        </Card>
      ) : null}

      {reviewEditor ? (
        <Card
          variant="bordered"
          padding="md"
          className="border-nq-warning/40 bg-nq-warning/10"
        >
          <h3 className="font-semibold text-nq-text">
            {reviewEditor.kind === "create_dispute" ||
            reviewEditor.kind === "create_skip_dispute"
              ? vi
                ? "Yêu cầu xem lại công bằng"
                : "Request a fairness review"
              : vi
                ? "Ghi kết quả xem lại"
                : "Record the review outcome"}
          </h3>
          {reviewEditor.kind === "create_dispute" ? (
            <label className="mt-3 block text-sm font-medium text-nq-text">
              {vi ? "Nội dung cần xem" : "Review category"}
              <select
                className="mt-2 min-h-11 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 text-base text-nq-text outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/40"
                value={disputeCategory}
                onChange={(event) =>
                  setDisputeCategory(
                    event.target.value as TurnIqCreateDisputeActionInput["command"]["category"],
                  )
                }
              >
                <option value="assignment">{vi ? "Phân công" : "Assignment"}</option>
                <option value="skip_reason">{vi ? "Lý do bỏ qua" : "Skip reason"}</option>
                <option value="turn_credit">{vi ? "Lượt" : "Turn credit"}</option>
                <option value="service_credit">{vi ? "Giá trị dịch vụ" : "Service credit"}</option>
                <option value="override">{vi ? "Thay đổi đề xuất" : "Override"}</option>
                <option value="other">{vi ? "Khác" : "Other"}</option>
              </select>
            </label>
          ) : null}
          <label className="mt-3 block text-sm font-medium text-nq-text">
            {reviewEditor.kind === "create_dispute" ||
            reviewEditor.kind === "create_skip_dispute"
              ? vi
                ? "Điều gì cần được kiểm tra?"
                : "What should be checked?"
              : vi
                ? "Lý do và kết quả"
                : "Reason and outcome"}
            <textarea
              autoFocus
              className="mt-2 min-h-24 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 py-3 text-base text-nq-text outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/40"
              maxLength={500}
              value={reviewReason}
              onChange={(event) => setReviewReason(event.target.value)}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              loading={isPending}
              disabled={!reviewReason.trim()}
              onClick={() =>
                submit(
                  reviewEditor.kind === "create_dispute" ||
                  reviewEditor.kind === "create_skip_dispute"
                    ? createDisputeCommand()
                    : resolveReviewCommand(),
                )
              }
            >
              {reviewEditor.kind === "create_dispute" ||
              reviewEditor.kind === "create_skip_dispute"
                ? vi
                  ? "Gửi xem lại"
                  : "Send for review"
                : vi
                  ? "Lưu kết quả"
                  : "Save outcome"}
            </Button>
            <Button
              variant="ghost"
              disabled={isPending}
              onClick={() => setReviewEditor(null)}
            >
              {vi ? "Đóng" : "Close"}
            </Button>
          </div>
        </Card>
      ) : null}

      {canSeeExceptionInbox && exceptionInbox ? (
        <Card
          variant="bordered"
          padding="md"
          className={
            exceptionInbox.ownerActionRequired
              ? "border-nq-warning/40 bg-nq-warning/10"
              : "border-nq-success/30 bg-nq-success/10"
          }
        >
          <div className="flex items-center gap-2">
            {exceptionInbox.ownerActionRequired ? (
              <AlertTriangle aria-hidden="true" className="size-5 text-nq-warning" />
            ) : (
              <Badge variant="success" state="subtle">OK</Badge>
            )}
            <h3 className="font-semibold text-nq-text">
              {vi ? "Ngoại lệ cần chủ salon" : "Owner Exception Inbox"}
            </h3>
          </div>
          {exceptionInbox.exceptions.length === 0 ? (
            <p className="mt-2 text-sm text-nq-muted">
              {vi
                ? "Không có ngoại lệ thật. Đội ngũ có thể tiếp tục mà không cần chủ duyệt."
                : "No real exception. The team can continue without owner approval."}
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {exceptionInbox.exceptions.map((entry) => (
                <li key={entry.id} className="rounded-2xl border border-nq-warning/30 bg-nq-surface p-3">
                  <p className="font-medium text-nq-text">{entry.privacySafeSummary}</p>
                  <p className="mt-1 text-sm text-nq-muted">
                    <strong>{vi ? "Đề xuất:" : "Recommended action:"}</strong>{" "}
                    {entry.recommendedAction}
                  </p>
                  {entry.dispute ? (
                    <div className="mt-2 rounded-xl border border-nq-border px-3 py-2 text-sm text-nq-text">
                      <p>{entry.dispute.privacySafeReason}</p>
                      <p className="mt-1 text-xs text-nq-muted">
                        {entry.dispute.targetType === "skip_decision"
                          ? vi
                            ? "Xem lại lý do bị bỏ qua"
                            : "Skip reason review"
                          : vi
                            ? "Xem lại biên nhận công bằng"
                            : "Fairness Receipt review"}
                        {" · "}
                        {vi ? "Loại:" : "Category:"} {entry.dispute.category}
                      </p>
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {entry.status === "open" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={isPending}
                        onClick={() =>
                          submit(
                            acknowledgeException({
                              id: entry.id,
                              policyVersionId: entry.policyVersionId,
                            }),
                          )
                        }
                      >
                        {vi ? "Đã nhận" : "Acknowledge"}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      disabled={isPending}
                      onClick={() => {
                        setReviewEditor(
                          entry.dispute
                            ? {
                                kind: "resolve_dispute",
                                disputeId: entry.dispute.id,
                                policyVersionId: entry.dispute.policyVersionId,
                                resolution: "resolved",
                              }
                            : {
                                kind: "resolve_exception",
                                exceptionId: entry.id,
                                policyVersionId: entry.policyVersionId,
                                resolution: "resolve_exception",
                              },
                        );
                        setReviewReason("");
                      }}
                    >
                      {vi ? "Giải quyết" : "Resolve"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isPending}
                      onClick={() => {
                        setReviewEditor(
                          entry.dispute
                            ? {
                                kind: "resolve_dispute",
                                disputeId: entry.dispute.id,
                                policyVersionId: entry.dispute.policyVersionId,
                                resolution: "dismissed",
                              }
                            : {
                                kind: "resolve_exception",
                                exceptionId: entry.id,
                                policyVersionId: entry.policyVersionId,
                                resolution: "dismiss_exception",
                              },
                        );
                        setReviewReason("");
                      }}
                    >
                      {vi ? "Đóng ngoại lệ" : "Dismiss"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {message ? (
        <p role="status" className="rounded-2xl border border-nq-border px-4 py-3 text-sm text-nq-text">
          {message}
        </p>
      ) : null}
    </section>
  );
}
