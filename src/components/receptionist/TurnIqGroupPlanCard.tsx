"use client";

import { useRef, useState, useTransition } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  RefreshCw,
  ShieldCheck,
  Users,
  WandSparkles,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { TurnIqGroupWhatIf } from "@/components/receptionist/TurnIqGroupWhatIf";
import { formatInSalonTz } from "@/shared/lib/salonTime";
import type {
  TurnIqGroupPlanView,
  TurnIqGroupQueueView,
} from "@/shared/turniq/groupReadModels";
import type {
  TurnIqGroupCommandActionResult,
  TurnIqGroupConfirmationActionInput,
  TurnIqGroupRecommendationActionInput,
  TurnIqGroupTimingComparisonActionInput,
  TurnIqGroupTimingComparisonActionResult,
  TurnIqStaggeredGroupConfirmationActionInput,
  TurnIqStaggeredGroupPlanActionInput,
  TurnIqServerActionErrorCode,
} from "@/shared/turniq/serverContracts";

type PlanReadResult =
  | { ok: true; data: TurnIqGroupPlanView }
  | { ok: false; code: TurnIqServerActionErrorCode };

type Props = {
  queue: TurnIqGroupQueueView | null;
  errorCode: string | null;
  language: "en" | "vi";
  timezone: string;
  slug: string;
  canManage: boolean;
  offline: boolean;
  onRecommend: (
    input: TurnIqGroupRecommendationActionInput,
  ) => Promise<TurnIqGroupCommandActionResult>;
  onConfirm: (
    input: TurnIqGroupConfirmationActionInput,
  ) => Promise<TurnIqGroupCommandActionResult>;
  onLoadPlan: (input: {
    slug: string;
    groupPlanId: string;
  }) => Promise<PlanReadResult>;
  onCompareTiming: (
    input: TurnIqGroupTimingComparisonActionInput,
  ) => Promise<TurnIqGroupTimingComparisonActionResult>;
  onRecordTimingPlan: (
    input: TurnIqStaggeredGroupPlanActionInput,
  ) => Promise<TurnIqGroupCommandActionResult>;
  onConfirmStaggered: (
    input: TurnIqStaggeredGroupConfirmationActionInput,
  ) => Promise<TurnIqGroupCommandActionResult>;
  onRefresh: () => Promise<void>;
};

type PendingRecommend = {
  key: string;
  input: TurnIqGroupRecommendationActionInput;
};

type PendingConfirm = {
  key: string;
  input: TurnIqGroupConfirmationActionInput;
};

type PendingStaggeredConfirm = {
  key: string;
  input: TurnIqStaggeredGroupConfirmationActionInput;
};

function actionError(code: string, vi: boolean): string {
  if (code === "stale_state") {
    return vi
      ? "Nhóm hoặc lịch salon vừa thay đổi. TurnIQ không lưu kế hoạch cũ và đang làm mới."
      : "The party or salon schedule changed. TurnIQ did not save the stale plan and is refreshing.";
  }
  if (code === "owner_confirmation_required") {
    return vi
      ? "Có ngoại lệ về thợ khách yêu cầu. Owner/Admin cần xem trước khi xác nhận."
      : "A requested-technician exception needs Owner/Admin review before confirmation.";
  }
  if (code === "feature_disabled") {
    return vi ? "TurnIQ đang tắt cho salon này." : "TurnIQ is off for this salon.";
  }
  if (code === "rollout_stage_blocked") {
    return vi
      ? "TurnIQ đang ở chế độ quan sát. Chưa thể xác nhận nhóm."
      : "TurnIQ is in observation mode. Party confirmation is not available yet.";
  }
  if (code === "forbidden") {
    return vi
      ? "Tài khoản này không có quyền xếp nhóm."
      : "This account cannot plan the party.";
  }
  return vi
    ? "Chưa nhận được kết quả. Bấm thử lại sẽ dùng đúng yêu cầu cũ để không tạo trùng."
    : "No result was received. Retry will reuse the same command so it cannot create a duplicate.";
}

function readinessCopy(
  readiness: TurnIqGroupQueueView["groups"][number]["readiness"],
  vi: boolean,
): string | null {
  if (readiness === "ready") return null;
  if (readiness === "partially_assigned") {
    return vi
      ? "Một số khách đã có thợ. TurnIQ dừng để tránh ghi đè phân công hiện tại."
      : "Some guests already have a technician. TurnIQ stopped to preserve current assignments.";
  }
  if (readiness === "mixed_start_times") {
    return vi
      ? "Nhóm có nhiều giờ bắt đầu. Cần quy tắc wave rõ ràng trước khi xếp."
      : "This party has mixed start times. A clear wave policy is required first.";
  }
  return vi
    ? "Kiểu lịch của nhóm này chưa nằm trong ranh giới xác nhận an toàn."
    : "This party schedule is outside the safe confirmation boundary.";
}

export function TurnIqGroupPlanCard({
  queue,
  errorCode,
  language,
  timezone,
  slug,
  canManage,
  offline,
  onRecommend,
  onConfirm,
  onLoadPlan,
  onCompareTiming,
  onRecordTimingPlan,
  onConfirmStaggered,
  onRefresh,
}: Props) {
  const vi = language === "vi";
  const [isPending, startTransition] = useTransition();
  const [selectedGroupId, setSelectedGroupId] = useState(
    queue?.groups[0]?.bookingGroupId ?? "",
  );
  const [plan, setPlan] = useState<TurnIqGroupPlanView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const recommendRetryRef = useRef<PendingRecommend | null>(null);
  const confirmRetryRef = useRef<PendingConfirm | null>(null);
  const staggeredConfirmRetryRef = useRef<PendingStaggeredConfirm | null>(null);

  const groups = queue?.groups ?? [];
  const selected =
    groups.find((group) => group.bookingGroupId === selectedGroupId) ??
    groups[0] ??
    null;
  const visiblePlan =
    plan && selected && plan.bookingGroupId === selected.bookingGroupId
      ? plan
      : null;

  function envelope() {
    deviceIdRef.current ??= crypto.randomUUID();
    sequenceRef.current = sequenceRef.current > 0
      ? sequenceRef.current + 1
      : Date.now();
    return {
      commandId: crypto.randomUUID(),
      deviceId: deviceIdRef.current,
      localSequence: sequenceRef.current,
    };
  }

  async function loadPlan(
    groupPlanId: string,
    preserveCommittedMessage = false,
  ): Promise<boolean> {
    try {
      const result = await onLoadPlan({ slug, groupPlanId });
      if (!result.ok) {
        if (!preserveCommittedMessage) setMessage(actionError(result.code, vi));
        return false;
      }
      setPlan(result.data);
      return true;
    } catch {
      if (!preserveCommittedMessage) {
        setMessage(actionError("server_error", vi));
      }
      return false;
    }
  }

  function recommend() {
    if (!selected || selected.readiness !== "ready" || offline) return;
    const key = selected.bookingGroupId;
    if (!recommendRetryRef.current || recommendRetryRef.current.key !== key) {
      recommendRetryRef.current = {
        key,
        input: {
          slug,
          bookingGroupId: selected.bookingGroupId,
          ...envelope(),
        },
      };
    }
    const pending = recommendRetryRef.current;
    setMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const result = await onRecommend(pending.input);
          if (!result.ok) {
            setMessage(actionError(result.code, vi));
            if (result.code !== "server_error") recommendRetryRef.current = null;
            if (result.code === "stale_state") await onRefresh();
            return;
          }
          recommendRetryRef.current = null;
          setMessage(
            vi
              ? `Đã tạo kế hoạch an toàn cho ${result.result.partySize} khách. Chưa thay đổi booking.`
              : `A safe plan was created for ${result.result.partySize} guests. Bookings are unchanged.`,
          );
          // The recommendation is committed even if the read-back is briefly
          // unavailable. Never turn that success into a duplicate retry prompt.
          await loadPlan(result.result.groupPlanId, true);
          await onRefresh().catch(() => undefined);
        } catch {
          setMessage(actionError("server_error", vi));
        }
      })();
    });
  }

  function confirm() {
    if (!visiblePlan || !visiblePlan.canConfirm || offline) return;
    if (visiblePlan.planningMode === "staggered") {
      const key = `${visiblePlan.id}:${visiblePlan.stateVersion}`;
      if (
        !staggeredConfirmRetryRef.current ||
        staggeredConfirmRetryRef.current.key !== key
      ) {
        staggeredConfirmRetryRef.current = {
          key,
          input: {
            slug,
            groupPlanId: visiblePlan.id,
            expectedStateVersion: visiblePlan.stateVersion,
            ...envelope(),
          },
        };
      }
      const pending = staggeredConfirmRetryRef.current;
      setMessage(null);
      startTransition(() => {
        void (async () => {
          try {
            const result = await onConfirmStaggered(pending.input);
            if (!result.ok) {
              setMessage(actionError(result.code, vi));
              if (result.code !== "server_error") {
                staggeredConfirmRetryRef.current = null;
              }
              if (result.code === "stale_state") await onRefresh();
              return;
            }
            staggeredConfirmRetryRef.current = null;
            setMessage(
              vi
                ? `Đã áp dụng nguyên nhóm và lưu ${result.result.fairnessReceiptIds.length} Fairness Receipt.`
                : `The entire party was applied and ${result.result.fairnessReceiptIds.length} Fairness Receipts were saved.`,
            );
            await loadPlan(result.result.groupPlanId, true);
            await onRefresh().catch(() => undefined);
          } catch {
            setMessage(actionError("server_error", vi));
          }
        })();
      });
      return;
    }
    const key = visiblePlan.id;
    if (!confirmRetryRef.current || confirmRetryRef.current.key !== key) {
      confirmRetryRef.current = {
        key,
        input: {
          slug,
          groupPlanId: visiblePlan.id,
          ...envelope(),
        },
      };
    }
    const pending = confirmRetryRef.current;
    setMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const result = await onConfirm(pending.input);
          if (!result.ok) {
            setMessage(actionError(result.code, vi));
            if (result.code !== "server_error") confirmRetryRef.current = null;
            if (
              result.code === "stale_state" ||
              result.code === "owner_confirmation_required"
            ) {
              await onRefresh();
            }
            return;
          }
          confirmRetryRef.current = null;
          setMessage(
            vi
              ? `Đã xác nhận nguyên nhóm. ${result.result.fairnessReceiptIds.length} Fairness Receipt đã được lưu.`
              : `The whole party is confirmed. ${result.result.fairnessReceiptIds.length} Fairness Receipts were saved.`,
          );
          // Confirmation is authoritative. A failed receipt refresh cannot
          // change success into a retry instruction.
          await loadPlan(result.result.groupPlanId, true);
          await onRefresh().catch(() => undefined);
        } catch {
          setMessage(actionError("server_error", vi));
        }
      })();
    });
  }

  return (
    <section
      aria-label={vi ? "TurnIQ xếp lịch nhóm" : "TurnIQ group planning"}
      className="rounded-[var(--radius-nq-card)] border border-nq-primary/35 bg-nq-surface p-4 shadow-[var(--shadow-nq-card)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="rounded-2xl bg-nq-primary/15 p-2 text-nq-primary">
            <Users aria-hidden="true" className="size-5" />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-nq-primary">
              TurnIQ Group
            </p>
            <h2 className="text-lg font-semibold text-nq-text">
              {vi ? "Xếp cả nhóm, xác nhận một lần" : "Plan the party, confirm once"}
            </h2>
            <p className="mt-1 text-sm text-nq-muted">
              {vi
                ? "TurnIQ kiểm tra toàn bộ thợ, giờ và ghế trước khi thay đổi bất kỳ booking nào."
                : "TurnIQ checks every technician, time, and resource before changing any booking."}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => void onRefresh()}
          leftIcon={<RefreshCw aria-hidden="true" className="size-4" />}
        >
          {vi ? "Làm mới" : "Refresh"}
        </Button>
      </div>

      {offline ? (
        <p className="mt-4 rounded-2xl border border-nq-warning/40 bg-nq-warning/10 p-3 text-sm text-nq-warning">
          {vi
            ? "Đang mất kết nối: bạn vẫn xem được dữ liệu gần nhất nhưng chưa thể xếp hoặc xác nhận nhóm."
            : "Offline: you can view the latest data, but cannot plan or confirm a party."}
        </p>
      ) : null}

      {!queue ? (
        <div className="mt-4 rounded-2xl border border-nq-warning/30 bg-nq-warning/10 p-3">
          <p className="font-medium text-nq-text">
            {vi ? "Chưa tải được danh sách nhóm" : "The party queue is unavailable"}
          </p>
          <p className="mt-1 text-sm text-nq-muted">
            {vi
              ? "TurnIQ chưa tự gán hoặc thay đổi booking nào."
              : "TurnIQ has not assigned or changed any booking."}
          </p>
          {errorCode ? <span className="sr-only">{errorCode}</span> : null}
        </div>
      ) : groups.length === 0 ? (
        <div className="mt-4 flex items-start gap-3 rounded-2xl border border-nq-success/30 bg-nq-success/10 p-3">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 text-nq-success" />
          <div>
            <p className="font-medium text-nq-text">
              {vi ? "Không có nhóm nào cần xếp" : "No party needs planning"}
            </p>
            <p className="mt-1 text-sm text-nq-muted">
              {vi
                ? "Đội ngũ có thể tiếp tục bình thường; không cần chủ can thiệp."
                : "The team can continue normally; no owner action is needed."}
            </p>
          </div>
        </div>
      ) : (
        <>
          <label className="mt-4 block text-sm font-medium text-nq-text">
            {vi ? "Nhóm cần xử lý" : "Party to plan"}
            <select
              value={selected?.bookingGroupId ?? ""}
              onChange={(event) => {
                setSelectedGroupId(event.target.value);
                setPlan(null);
                setMessage(null);
                recommendRetryRef.current = null;
                confirmRetryRef.current = null;
                staggeredConfirmRetryRef.current = null;
              }}
              className="mt-1 min-h-12 w-full rounded-2xl border border-nq-border bg-nq-surface px-4 text-base text-nq-text outline-none focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/40"
            >
              {groups.map((group) => (
                <option key={group.bookingGroupId} value={group.bookingGroupId}>
                  {formatInSalonTz(group.requestedStartAt, timezone, "time")} · {group.partySize} {vi ? "khách" : "guests"} · {group.serviceSummary}
                </option>
              ))}
            </select>
          </label>

          {selected ? (
            <div className="mt-3 rounded-2xl border border-nq-border/70 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xl font-semibold text-nq-text">
                    {selected.partySize} {vi ? "khách" : "guests"} · {formatInSalonTz(selected.requestedStartAt, timezone, "time")}
                  </p>
                  <p className="mt-1 text-sm text-nq-muted">{selected.serviceSummary}</p>
                </div>
                {selected.existingPlanStatus ? (
                  <span className="rounded-full bg-nq-success/15 px-3 py-1 text-xs font-semibold text-nq-success">
                    {selected.existingPlanStatus === "recommended"
                      ? vi ? "Đã có kế hoạch" : "Plan ready"
                      : selected.existingPlanStatus}
                  </span>
                ) : null}
              </div>

              {readinessCopy(selected.readiness, vi) ? (
                <p className="mt-3 flex items-start gap-2 rounded-xl border border-nq-warning/40 bg-nq-warning/10 p-3 text-sm text-nq-warning">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  {readinessCopy(selected.readiness, vi)}
                </p>
              ) : null}

              {canManage && selected.readiness === "ready" ? (
                <>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {selected.existingPlanId ? (
                      <Button
                        size="lg"
                        loading={isPending}
                        disabled={offline}
                        onClick={() => {
                          setMessage(null);
                          startTransition(() => {
                            void loadPlan(selected.existingPlanId!);
                          });
                        }}
                        leftIcon={<Users aria-hidden="true" className="size-5" />}
                      >
                        {vi ? "Mở kế hoạch nhóm" : "Open group plan"}
                      </Button>
                    ) : (
                      <Button
                        size="lg"
                        loading={isPending}
                        disabled={offline}
                        onClick={recommend}
                        leftIcon={<WandSparkles aria-hidden="true" className="size-5" />}
                      >
                        {vi ? "Tạo kế hoạch an toàn" : "Build safe plan"}
                      </Button>
                    )}
                  </div>
                  {!selected.existingPlanId ? (
                    <TurnIqGroupWhatIf
                      key={selected.bookingGroupId}
                      bookingGroupId={selected.bookingGroupId}
                      language={language}
                      timezone={timezone}
                      slug={slug}
                      offline={offline}
                      onCompare={onCompareTiming}
                      onRecordPlan={onRecordTimingPlan}
                      onPlanRecorded={async (groupPlanId) => {
                        await loadPlan(groupPlanId, true);
                        await onRefresh().catch(() => undefined);
                      }}
                    />
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {visiblePlan ? (
        <article className="mt-4 rounded-2xl border border-nq-gold/40 bg-nq-gold/10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-nq-text">
                {visiblePlan.status === "confirmed"
                  ? vi ? "Nhóm đã được xác nhận" : "Party confirmed"
                  : vi ? "Kế hoạch đề xuất" : "Recommended plan"}
              </h3>
              <p className="mt-1 text-sm leading-6 text-nq-muted">
                {visiblePlan.explanation}
              </p>
              {visiblePlan.planningMode === "staggered" ? (
                <p className="mt-2 rounded-xl border border-nq-warning/30 bg-nq-surface p-3 text-sm font-medium text-nq-text">
                  {vi
                    ? "Bước xác nhận sẽ đổi giờ, thợ và ghế cho toàn bộ nhóm trong một lần. Nếu một khách xung đột, không booking nào bị đổi."
                    : "Confirmation changes time, technician, and resource for the whole party in one transaction. If one guest conflicts, no booking changes."}
                </p>
              ) : null}
            </div>
            {visiblePlan.eta ? (
              <span className="flex items-center gap-2 rounded-full bg-nq-surface px-3 py-2 text-sm font-medium text-nq-text">
                <Clock3 aria-hidden="true" className="size-4 text-nq-gold" />
                {vi ? "Bắt đầu hết trong" : "All started within"} {visiblePlan.eta.allStartedByMinutes}′
              </span>
            ) : null}
          </div>

          <ol className="mt-4 grid gap-3 sm:grid-cols-2" aria-label={vi ? "Phân công nhóm" : "Party assignments"}>
            {visiblePlan.assignments.map((assignment, index) => (
              <li key={assignment.assignmentId} className="rounded-xl border border-nq-border/70 bg-nq-surface p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
                  {vi ? `Khách ${index + 1}` : `Guest ${index + 1}`}
                </p>
                <p className="mt-1 text-lg font-semibold text-nq-text">
                  {assignment.staff.name}
                </p>
                <p className="text-sm text-nq-muted">{assignment.service.name}</p>
                <p className="mt-2 text-sm text-nq-text">
                  {formatInSalonTz(assignment.startsAt, timezone, "time")}–{formatInSalonTz(assignment.safeEndAt, timezone, "time")}
                  {assignment.resource ? ` · ${assignment.resource.name}` : ""}
                  {assignment.waveNumber
                    ? ` · ${vi ? "Đợt" : "Wave"} ${assignment.waveNumber}`
                    : ""}
                </p>
              </li>
            ))}
          </ol>

          {visiblePlan.ownerActionRequired ? (
            <p className="mt-4 flex items-start gap-2 rounded-xl border border-nq-warning/40 bg-nq-warning/10 p-3 text-sm text-nq-warning">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {vi
                ? "Có ngoại lệ về thợ khách yêu cầu. Giữ nguyên booking và chuyển Owner/Admin xem xét."
                : "A requested-technician exception needs Owner/Admin review. Bookings remain unchanged."}
            </p>
          ) : null}

          {canManage && visiblePlan.canConfirm ? (
            <Button
              className="mt-4 w-full sm:w-auto"
              size="lg"
              loading={isPending}
              disabled={offline}
              onClick={confirm}
              leftIcon={<CheckCircle2 aria-hidden="true" className="size-5" />}
            >
              {visiblePlan.planningMode === "staggered"
                ? vi
                  ? `Áp dụng và xác nhận cả ${visiblePlan.partySize} khách`
                  : `Apply and confirm all ${visiblePlan.partySize} guests`
                : vi
                  ? `Xác nhận cả ${visiblePlan.partySize} khách`
                  : `Confirm all ${visiblePlan.partySize} guests`}
            </Button>
          ) : null}

          {visiblePlan.status === "confirmed" ? (
            <p className="mt-4 flex items-center gap-2 text-sm font-medium text-nq-success">
              <CheckCircle2 aria-hidden="true" className="size-5" />
              {visiblePlan.fairnessReceiptCount} Fairness Receipt {vi ? "đã lưu" : "saved"}
            </p>
          ) : null}
        </article>
      ) : null}

      {message ? (
        <p role="status" className="mt-4 rounded-2xl border border-nq-border/70 p-3 text-sm text-nq-text">
          {message}
        </p>
      ) : null}
    </section>
  );
}
