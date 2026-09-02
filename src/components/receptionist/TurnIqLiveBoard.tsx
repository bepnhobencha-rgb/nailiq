"use client";

import { useRef, useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Scale,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import type { TurnIqReasonCode } from "@/shared/turniq/contracts";
import type {
  TurnIqFairnessReceiptView,
  TurnIqLiveBoardView,
} from "@/shared/turniq/readModels";
import type {
  TurnIqAssignmentActionInput,
  TurnIqCommandActionResult,
  TurnIqServerActionErrorCode,
} from "@/shared/turniq/serverContracts";
import type { TurnIqRolloutStage } from "@/shared/turniq/rolloutStage";

type TurnIqLiveBoardProps = {
  board: TurnIqLiveBoardView | null;
  errorCode: string | null;
  language: "en" | "vi";
  slug?: string;
  canManage?: boolean;
  rolloutStage?: TurnIqRolloutStage;
  onRefresh?: () => Promise<void>;
  onApplyCommand?: (
    input: TurnIqAssignmentActionInput,
  ) => Promise<TurnIqCommandActionResult>;
  onLoadReceipt?: (input: {
    slug: string;
    receiptId: string;
  }) => Promise<
    | { ok: true; data: TurnIqFairnessReceiptView }
    | { ok: false; code: TurnIqServerActionErrorCode }
  >;
};

type PendingCommand = {
  key: string;
  input: TurnIqAssignmentActionInput;
};

const REASON_LABELS: Partial<
  Record<TurnIqReasonCode, { en: string; vi: string }>
> = {
  CURRENTLY_BUSY: { en: "currently serving", vi: "đang phục vụ khách" },
  APPROVED_BREAK: { en: "approved break", vi: "đang nghỉ đã duyệt" },
  TEMPORARY_HOLD: { en: "temporary hold", vi: "đang tạm giữ lượt" },
  SKILL_MISMATCH: { en: "service skill mismatch", vi: "chưa phù hợp kỹ năng" },
  CAPABILITY_DATA_INCOMPLETE: {
    en: "skills need verification",
    vi: "cần xác minh kỹ năng",
  },
  INSUFFICIENT_APPOINTMENT_GAP: {
    en: "not enough time before the next booking",
    vi: "không đủ thời gian trước lịch kế tiếp",
  },
  NOT_CHECKED_IN: { en: "not checked in", vi: "chưa check-in" },
  STAFF_INACTIVE: { en: "not active", vi: "chưa hoạt động" },
  RESOURCE_UNAVAILABLE: {
    en: "required chair or room unavailable",
    vi: "ghế hoặc phòng cần thiết chưa trống",
  },
  ACTIVE_REFUSAL_PENALTY: {
    en: "active refusal rule",
    vi: "đang áp dụng quy tắc từ chối lượt",
  },
  MANUAL_SAFETY_HOLD: { en: "safety hold", vi: "đang giữ vì an toàn" },
};

function reasonLabel(codes: readonly TurnIqReasonCode[], language: "en" | "vi") {
  const reason = codes.find((code) => REASON_LABELS[code]);
  return reason ? REASON_LABELS[reason]?.[language] : null;
}

export function TurnIqLiveBoard({
  board,
  errorCode,
  language,
  slug,
  canManage = false,
  rolloutStage = "off",
  onRefresh,
  onApplyCommand,
  onLoadReceipt,
}: TurnIqLiveBoardProps) {
  const vi = language === "vi";
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<TurnIqFairnessReceiptView | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideStaffId, setOverrideStaffId] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const deviceIdRef = useRef<string | null>(null);
  const localSequenceRef = useRef(0);
  const retryCommandRef = useRef<PendingCommand | null>(null);

  const next = board?.nextRecommendation ?? null;

  function commandFor(
    type: "confirm" | "override",
    assignedStaffId: string,
    reason?: string,
  ): PendingCommand | null {
    if (!slug || !next || !onApplyCommand) return null;
    const key = [next.assignmentId, type, assignedStaffId, reason ?? ""].join(":");
    if (retryCommandRef.current?.key === key) return retryCommandRef.current;
    deviceIdRef.current ??= crypto.randomUUID();
    localSequenceRef.current =
      localSequenceRef.current > 0
        ? localSequenceRef.current + 1
        : Date.now();
    const input: TurnIqAssignmentActionInput = {
      slug,
      policyVersionId: next.policyVersionId,
      assignmentId: next.assignmentId,
      commandId: crypto.randomUUID(),
      deviceId: deviceIdRef.current,
      localSequence: localSequenceRef.current,
      command:
        type === "confirm"
          ? { type, assignedStaffId }
          : { type, assignedStaffId, reason: reason ?? "" },
    };
    retryCommandRef.current = { key, input };
    return retryCommandRef.current;
  }

  function localizedError(code: string): string {
    if (code === "stale_state") {
      return vi
        ? "Lịch vừa thay đổi. TurnIQ đã dừng an toàn và đang làm mới đề xuất."
        : "The schedule changed. TurnIQ stopped safely and is refreshing the recommendation.";
    }
    if (code === "owner_confirmation_required") {
      return vi
        ? "Ngoại lệ tự gán đã được chuyển cho Owner/Admin duyệt."
        : "The self-assignment exception was sent to an Owner/Admin for review.";
    }
    if (code === "feature_disabled") {
      return vi ? "TurnIQ đang tắt cho salon này." : "TurnIQ is off for this salon.";
    }
    if (code === "rollout_stage_blocked") {
      return vi
        ? "TurnIQ đang ở chế độ quan sát. Chưa thể thay đổi lượt."
        : "TurnIQ is in observation mode. Turn changes are not available yet.";
    }
    if (code === "forbidden") {
      return vi
        ? "Tài khoản này không có quyền xác nhận lượt."
        : "This account cannot confirm turns.";
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
      ? "Chưa thể xác nhận. Không có thay đổi nào được lưu; bạn có thể thử lại."
      : "Confirmation did not finish. Nothing changed; you can retry.";
  }

  function submitCommand(command: PendingCommand | null) {
    if (!command || !slug || !onApplyCommand) return;
    setMessage(null);
    setReceipt(null);
    startTransition(() => {
      void (async () => {
        try {
          const result = await onApplyCommand(command.input);
          if (!result.ok) {
            setMessage(localizedError(result.code));
            if (result.code !== "server_error") retryCommandRef.current = null;
            if (result.code === "stale_state" || result.code === "owner_confirmation_required") {
              await onRefresh?.();
            }
            return;
          }
          retryCommandRef.current = null;
          setOverrideOpen(false);
          setOverrideReason("");
          setOverrideStaffId("");
          const receiptId = result.result.fairnessReceiptId;
          if (result.result.status === "queued_offline") {
            setMessage(
              vi
                ? "Đã lưu an toàn trên máy. Chưa đồng bộ cloud và chưa tạo Fairness Receipt."
                : "Saved safely on this device. Cloud sync and the Fairness Receipt are still pending.",
            );
            return;
          }
          setMessage(
            vi
              ? "Đã xác nhận an toàn. Fairness Receipt đã được lưu."
              : "Safely confirmed. The Fairness Receipt was saved.",
          );
          // Confirmation is authoritative once the command returns success.
          // Receipt/read refresh failures must never turn that committed
          // success into a retry prompt that could confuse the desk user.
          if (receiptId && onLoadReceipt) {
            try {
              const receiptResult = await onLoadReceipt({ slug, receiptId });
              if (receiptResult.ok) setReceipt(receiptResult.data);
            } catch {
              // The receipt is durable; the next board refresh can reload it.
            }
          }
          try {
            await onRefresh?.();
          } catch {
            // Preserve committed success; Receptionist Center owns reconnect UI.
          }
        } catch {
          // Keep the exact command envelope so a retry cannot duplicate a
          // confirmation whose response was lost in transit.
          setMessage(localizedError("server_error"));
        }
      })();
    });
  }

  if (!board) {
    return (
      <section
        aria-label="TurnIQ Live Board"
        className="rounded-[var(--radius-nq-card)] border border-nq-warning/40 bg-nq-warning/10 px-4 py-3"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-nq-warning" />
          <div>
            <p className="font-semibold text-nq-text">
              {vi ? "TurnIQ chưa thể xác minh lượt" : "TurnIQ could not verify the next turn"}
            </p>
            <p className="mt-1 text-sm text-nq-muted">
              {vi
                ? "Tiếp tục theo quy trình hiện tại; NailIQ chưa tự gán thợ."
                : "Continue with the current process; NailIQ has not auto-assigned anyone."}
            </p>
            {errorCode ? <span className="sr-only">{errorCode}</span> : null}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="TurnIQ Live Board"
      className="rounded-[var(--radius-nq-card)] border border-nq-gold/40 bg-nq-surface px-4 py-4 shadow-[var(--shadow-nq-card)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Scale aria-hidden="true" className="size-5 text-nq-gold" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-nq-gold">
              {rolloutStage === "shadow"
                ? "TurnIQ Shadow"
                : rolloutStage === "supervised"
                  ? "TurnIQ Supervised"
                  : "TurnIQ Live"}
            </p>
            <h2 className="text-lg font-semibold text-nq-text">
              {vi ? "Lượt tiếp theo" : "Next turn"}
            </h2>
          </div>
        </div>
        <div
          className={`flex min-h-11 items-center gap-2 rounded-full px-3 text-sm font-medium ${
            board.ownerActionRequired
              ? "bg-nq-warning/15 text-nq-warning"
              : "bg-nq-success/15 text-nq-success"
          }`}
        >
          {board.ownerActionRequired ? (
            <AlertTriangle aria-hidden="true" className="size-4" />
          ) : (
            <ShieldCheck aria-hidden="true" className="size-4" />
          )}
          {board.ownerActionRequired
            ? vi
              ? `${board.openExceptionCount} ngoại lệ cần chủ xem`
              : `${board.openExceptionCount} exception(s) need owner review`
            : vi
              ? "Không cần chủ can thiệp"
              : "No owner action needed"}
        </div>
      </div>

      {next ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(15rem,1fr)]">
          <div className="rounded-[var(--radius-nq-control)] border border-nq-gold/30 bg-nq-gold/10 p-4">
            <p className="text-sm text-nq-muted">
              {vi ? "Đề xuất cho khách kế tiếp" : "Recommended for the next customer"}
            </p>
            <p className="mt-1 text-2xl font-bold text-nq-text">
              {next.recommendedStaffName}
            </p>
            {next.serviceName ? (
              <p className="mt-1 text-sm font-medium text-nq-text">{next.serviceName}</p>
            ) : null}
            <p className="mt-2 text-sm leading-6 text-nq-muted">
              {next.explanation}
            </p>
            {next.blockedByException ? (
              <p className="mt-3 rounded-2xl border border-nq-warning/40 bg-nq-warning/10 px-3 py-2 text-sm font-medium text-nq-warning">
                {vi
                  ? "Chưa thể xác nhận: Owner/Admin cần xử lý ngoại lệ và tạo đề xuất mới."
                  : "Confirmation is blocked: Owner/Admin must resolve the exception and create a fresh recommendation."}
              </p>
            ) : null}
            {canManage && slug && onApplyCommand ? (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  size="lg"
                  loading={isPending}
                  disabled={next.blockedByException === true}
                  onClick={() =>
                    submitCommand(
                      commandFor("confirm", next.recommendedStaffId),
                    )
                  }
                  leftIcon={<CheckCircle2 className="size-5" />}
                >
                  {vi ? `Xác nhận ${next.recommendedStaffName}` : `Confirm ${next.recommendedStaffName}`}
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  disabled={isPending || next.blockedByException === true}
                  onClick={() => setOverrideOpen((open) => !open)}
                >
                  {vi ? "Chọn người khác" : "Choose someone else"}
                </Button>
              </div>
            ) : null}
          </div>

          <div className="rounded-[var(--radius-nq-control)] border border-nq-border/70 p-4">
            <p className="text-sm font-semibold text-nq-text">
              {vi ? "Vì sao người trước được bỏ qua?" : "Why were others skipped?"}
            </p>
            {next.skipped.length > 0 ? (
              <ul className="mt-2 space-y-2 text-sm text-nq-muted">
                {next.skipped.slice(0, 3).map((candidate) => (
                  <li key={candidate.staffId} className="flex items-start gap-2">
                    <span aria-hidden="true">•</span>
                    <span>
                      <strong className="font-medium text-nq-text">
                        {candidate.staffName}:
                      </strong>{" "}
                      {reasonLabel(candidate.reasonCodes, language) ??
                        (vi ? "không đủ điều kiện an toàn" : "not safely eligible")}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 flex items-center gap-2 text-sm text-nq-muted">
                <CheckCircle2 aria-hidden="true" className="size-4 text-nq-success" />
                {vi ? "Không có lượt nào bị bỏ qua." : "No earlier turn was skipped."}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-[var(--radius-nq-control)] border border-nq-border/70 p-4">
          <p className="font-medium text-nq-text">
            {vi ? "Chưa có khách cần đề xuất lượt." : "No customer needs a turn recommendation yet."}
          </p>
          <p className="mt-1 text-sm text-nq-muted">
            {vi
              ? "Danh sách check-in vẫn sẵn sàng và không có thao tác tự động nào."
              : "The checked-in queue remains ready and no automatic action was taken."}
          </p>
        </div>
      )}

      {next && canManage && slug && onApplyCommand && overrideOpen ? (
        <div className="mt-4 rounded-[var(--radius-nq-control)] border border-nq-warning/40 bg-nq-warning/10 p-4">
          <h3 className="font-semibold text-nq-text">
            {vi ? "Ghi nhận ngoại lệ" : "Record an exception"}
          </h3>
          <p className="mt-1 text-sm text-nq-muted">
            {vi
              ? "TurnIQ sẽ kiểm tra lại kỹ năng, thời gian và ghế/phòng trước khi lưu. Lý do sẽ nằm trong Fairness Receipt."
              : "TurnIQ rechecks skill, timing, and chair/room safety before saving. The reason stays in the Fairness Receipt."}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-nq-text">
              {vi ? "Nhân viên thực hiện" : "Assigned technician"}
              <select
                className="mt-1 min-h-12 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 text-base text-nq-text outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/40"
                value={overrideStaffId}
                onChange={(event) => setOverrideStaffId(event.target.value)}
              >
                <option value="">{vi ? "Chọn nhân viên" : "Choose technician"}</option>
                {board.staff
                  .filter(
                    (staff) =>
                      staff.state === "active" &&
                      staff.staffId !== next.recommendedStaffId,
                  )
                  .map((staff) => (
                    <option key={staff.staffId} value={staff.staffId}>
                      {staff.staffName}
                    </option>
                  ))}
              </select>
            </label>
            <label className="text-sm font-medium text-nq-text">
              {vi ? "Lý do bắt buộc" : "Required reason"}
              <textarea
                className="mt-1 min-h-24 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 py-3 text-base text-nq-text outline-none placeholder:text-nq-muted focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/40"
                maxLength={500}
                placeholder={
                  vi
                    ? "Ví dụ: khách yêu cầu trực tiếp khi check-in"
                    : "Example: customer requested them at check-in"
                }
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              loading={isPending}
              disabled={!overrideStaffId || !overrideReason.trim()}
              onClick={() =>
                submitCommand(
                  commandFor(
                    "override",
                    overrideStaffId,
                    overrideReason.trim(),
                  ),
                )
              }
            >
              {vi ? "Xác nhận ngoại lệ" : "Confirm override"}
            </Button>
            <Button
              variant="ghost"
              disabled={isPending}
              onClick={() => setOverrideOpen(false)}
            >
              {vi ? "Đóng" : "Close"}
            </Button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p
          role="status"
          className="mt-4 rounded-[var(--radius-nq-control)] border border-nq-border/70 px-4 py-3 text-sm text-nq-text"
        >
          {message}
        </p>
      ) : null}

      {receipt ? (
        <article className="mt-4 rounded-[var(--radius-nq-control)] border border-nq-success/40 bg-nq-success/10 p-4">
          <div className="flex items-center gap-2 text-nq-success">
            <ClipboardCheck aria-hidden="true" className="size-5" />
            <h3 className="font-semibold">
              {vi ? "Fairness Receipt đã lưu" : "Fairness Receipt saved"}
            </h3>
          </div>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-nq-muted">{vi ? "Đề xuất" : "Recommended"}</dt>
              <dd className="font-medium text-nq-text">
                {receipt.recommendedStaffName ?? (vi ? "Không có" : "None")}
              </dd>
            </div>
            <div>
              <dt className="text-nq-muted">{vi ? "Đã giao" : "Assigned"}</dt>
              <dd className="font-medium text-nq-text">{receipt.assignedStaffName}</dd>
            </div>
          </dl>
          <p className="mt-3 text-sm leading-6 text-nq-muted">
            {receipt.explanation}
          </p>
          {receipt.overrideReason ? (
            <p className="mt-2 text-sm text-nq-text">
              <strong>{vi ? "Lý do ngoại lệ:" : "Override reason:"}</strong>{" "}
              {receipt.overrideReason}
            </p>
          ) : null}
          {receipt.corrections.length > 0 ? (
            <div className="mt-3 rounded-2xl border border-nq-warning/30 bg-nq-warning/10 p-3 text-sm">
              <p className="font-semibold text-nq-text">
                {vi ? "Lịch sử hiệu chỉnh — receipt gốc giữ nguyên" : "Correction history — original receipt preserved"}
              </p>
              <ul className="mt-2 space-y-2">
                {receipt.corrections.map((correction) => (
                  <li key={correction.id} className="text-nq-muted">
                    <span className="font-medium text-nq-text">
                      #{correction.sequence} · {correction.previousStaffName} → {correction.actualStaffName}
                    </span>
                    {" — "}{correction.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}
