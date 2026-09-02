"use client";

import { useRef, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Clock3, FlaskConical, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { formatInSalonTz } from "@/shared/lib/salonTime";
import type {
  TurnIqGroupTimingComparisonView,
  TurnIqGroupTimingOptionView,
} from "@/shared/turniq/groupReadModels";
import type {
  TurnIqGroupTimingComparisonActionInput,
  TurnIqGroupTimingComparisonActionResult,
  TurnIqGroupCommandActionResult,
  TurnIqStaggeredGroupPlanActionInput,
} from "@/shared/turniq/serverContracts";

type Props = {
  bookingGroupId: string;
  language: "en" | "vi";
  timezone: string;
  slug: string;
  offline: boolean;
  initialComparison?: TurnIqGroupTimingComparisonView | null;
  onCompare: (
    input: TurnIqGroupTimingComparisonActionInput,
  ) => Promise<TurnIqGroupTimingComparisonActionResult>;
  onRecordPlan: (
    input: TurnIqStaggeredGroupPlanActionInput,
  ) => Promise<TurnIqGroupCommandActionResult>;
  onPlanRecorded: (groupPlanId: string) => Promise<void>;
};

type PendingRecord = {
  key: string;
  input: TurnIqStaggeredGroupPlanActionInput;
};

const INTENT_LABELS = {
  start_together: { en: "Arrive together", vi: "Đến cùng lúc" },
  finish_together: { en: "Leave together", vi: "Về cùng lúc" },
  smart_wave: { en: "Smart Wave", vi: "Chia đợt thông minh" },
} as const;

function bestOption(
  options: readonly TurnIqGroupTimingOptionView[],
): TurnIqGroupTimingOptionView | null {
  return [...options]
    .filter((option) => option.feasible && option.metrics)
    .sort((left, right) => {
      const leftMetrics = left.metrics!;
      const rightMetrics = right.metrics!;
      return (
        leftMetrics.maximumWaitMinutes - rightMetrics.maximumWaitMinutes ||
        leftMetrics.totalWaitMinutes - rightMetrics.totalWaitMinutes ||
        leftMetrics.latestReleaseMinutes - rightMetrics.latestReleaseMinutes ||
        leftMetrics.waveCount - rightMetrics.waveCount ||
        left.intent.localeCompare(right.intent)
      );
    })[0] ?? null;
}

export function TurnIqGroupWhatIf({
  bookingGroupId,
  language,
  timezone,
  slug,
  offline,
  initialComparison = null,
  onCompare,
  onRecordPlan,
  onPlanRecorded,
}: Props) {
  const vi = language === "vi";
  const [isPending, startTransition] = useTransition();
  const [windowMinutes, setWindowMinutes] = useState(240);
  const [finishOffsetMinutes, setFinishOffsetMinutes] = useState(120);
  const [comparison, setComparison] =
    useState<TurnIqGroupTimingComparisonView | null>(initialComparison);
  const [message, setMessage] = useState<string | null>(null);
  const [recordedPlanId, setRecordedPlanId] = useState<string | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const recordRetryRef = useRef<PendingRecord | null>(null);
  const best = comparison ? bestOption(comparison.options) : null;

  function envelope() {
    deviceIdRef.current ??= crypto.randomUUID();
    sequenceRef.current += 1;
    return {
      commandId: crypto.randomUUID(),
      deviceId: deviceIdRef.current,
      localSequence: sequenceRef.current,
    };
  }

  function compare() {
    if (offline) return;
    setMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const result = await onCompare({
            slug,
            bookingGroupId,
            windowMinutes,
            finishOffsetMinutes,
          });
          if (!result.ok) {
            setMessage(
              result.code === "stale_state"
                ? vi
                  ? "Lịch vừa thay đổi. Chưa có booking nào bị sửa; hãy làm mới rồi so sánh lại."
                  : "The schedule changed. No booking was modified; refresh and compare again."
                : vi
                  ? "Chưa so sánh được. Không có booking nào bị thay đổi."
                  : "The comparison is unavailable. No booking was changed.",
            );
            return;
          }
          if (result.data.bookingGroupId !== bookingGroupId) {
            setMessage(
              vi
                ? "Kết quả không còn thuộc nhóm đang xem. Không có booking nào bị thay đổi."
                : "The result no longer belongs to this party. No booking was changed.",
            );
            return;
          }
          setComparison(result.data);
          setRecordedPlanId(null);
          recordRetryRef.current = null;
          setMessage(
            vi
              ? "Đã so sánh trên cùng một ảnh chụp lịch. Đây chỉ là mô phỏng."
              : "Compared on one schedule snapshot. This is simulation only.",
          );
        } catch {
          setMessage(
            vi
              ? "Mất kết nối khi so sánh. Không có booking nào bị thay đổi."
              : "The comparison lost connection. No booking was changed.",
          );
        }
      })();
    });
  }

  function recordPlan(option: TurnIqGroupTimingOptionView) {
    if (!comparison || !option.feasible || !option.metrics || offline) return;
    const key = `${comparison.snapshotVersion}:${option.simulationId}`;
    if (!recordRetryRef.current || recordRetryRef.current.key !== key) {
      recordRetryRef.current = {
        key,
        input: {
          slug,
          bookingGroupId,
          intent: option.intent,
          windowMinutes: comparison.windowMinutes,
          finishOffsetMinutes: comparison.finishOffsetMinutes,
          expectedSimulationId: option.simulationId,
          expectedSimulationFingerprint: option.simulationFingerprint,
          expectedSnapshotVersion: comparison.snapshotVersion,
          comparedAt: comparison.comparedAt,
          ...envelope(),
        },
      };
    }
    const pending = recordRetryRef.current;
    setMessage(null);
    startTransition(() => {
      void (async () => {
        try {
          const result = await onRecordPlan(pending.input);
          if (!result.ok) {
            setMessage(
              result.code === "stale_state"
                ? vi
                  ? "Lịch vừa thay đổi hoặc mô phỏng đã quá 5 phút. Không booking nào bị đổi; hãy so sánh lại."
                  : "The schedule changed or this simulation is over 5 minutes old. No booking changed; compare again."
                : vi
                  ? "Chưa lưu được kế hoạch. Không booking nào bị thay đổi; thử lại sẽ dùng đúng yêu cầu cũ."
                  : "The plan was not saved. No booking changed; retry reuses the same command.",
            );
            if (result.code !== "server_error") recordRetryRef.current = null;
            return;
          }
          recordRetryRef.current = null;
          setRecordedPlanId(result.result.groupPlanId);
          setMessage(
            vi
              ? `Đã khóa kế hoạch cho ${result.result.partySize} khách để kiểm tra. Booking vẫn chưa đổi; cần bấm xác nhận cả nhóm ở bước kế tiếp.`
              : `The ${result.result.partySize}-guest plan is saved for review. Bookings are still unchanged; confirm the whole party next.`,
          );
          // The command receipt is authoritative. A read-back failure must not
          // turn committed plan creation into a duplicate retry prompt.
          await onPlanRecorded(result.result.groupPlanId).catch(() => undefined);
        } catch {
          setMessage(
            vi
              ? "Mất kết nối trước khi nhận kết quả. Thử lại sẽ dùng đúng yêu cầu cũ để không tạo trùng."
              : "Connection was lost before the result arrived. Retry reuses the same command to prevent duplicates.",
          );
        }
      })();
    });
  }

  return (
    <section className="mt-4 rounded-2xl border border-dashed border-nq-primary/40 bg-nq-primary/5 p-4">
      <div className="flex items-start gap-3">
        <span className="rounded-xl bg-nq-primary/15 p-2 text-nq-primary">
          <FlaskConical aria-hidden="true" className="size-5" />
        </span>
        <div>
          <p className="font-semibold text-nq-text">
            {vi ? "What if? So sánh trước khi đổi lịch" : "What if? Compare before changing anything"}
          </p>
          <p className="mt-1 text-sm text-nq-muted">
            {vi
              ? "Ba phương án dùng cùng dữ liệu hiện tại. Chọn một cách để lưu kế hoạch xem trước; booking chỉ đổi sau bước xác nhận riêng."
              : "All three options use the same current facts. Save one for review; bookings change only after a separate confirmation."}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-nq-text">
          {vi ? "Tìm trong khoảng" : "Search window"}
          <select
            value={windowMinutes}
            onChange={(event) => setWindowMinutes(Number(event.target.value))}
            className="mt-1 min-h-11 w-full rounded-xl border border-nq-border bg-nq-surface px-3 text-base text-nq-text"
          >
            <option value={120}>{vi ? "2 giờ" : "2 hours"}</option>
            <option value={240}>{vi ? "4 giờ" : "4 hours"}</option>
            <option value={360}>{vi ? "6 giờ" : "6 hours"}</option>
          </select>
        </label>
        <label className="text-sm font-medium text-nq-text">
          {vi ? "Mục tiêu về cùng lúc" : "Leave-together target"}
          <select
            value={finishOffsetMinutes}
            onChange={(event) =>
              setFinishOffsetMinutes(Number(event.target.value))
            }
            className="mt-1 min-h-11 w-full rounded-xl border border-nq-border bg-nq-surface px-3 text-base text-nq-text"
          >
            <option value={90}>{vi ? "+ 90 phút" : "+ 90 minutes"}</option>
            <option value={120}>{vi ? "+ 2 giờ" : "+ 2 hours"}</option>
            <option value={180}>{vi ? "+ 3 giờ" : "+ 3 hours"}</option>
          </select>
        </label>
      </div>

      <Button
        className="mt-3 w-full sm:w-auto"
        variant="secondary"
        loading={isPending}
        disabled={offline}
        onClick={compare}
        leftIcon={<FlaskConical aria-hidden="true" className="size-4" />}
      >
        {vi ? "So sánh 3 cách" : "Compare all 3 options"}
      </Button>

      {offline ? (
        <p className="mt-3 flex items-start gap-2 text-sm text-nq-warning">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {vi
            ? "Đang offline: giữ kết quả cũ để xem, nhưng không chạy mô phỏng mới."
            : "Offline: the last result stays visible, but a new simulation cannot run."}
        </p>
      ) : null}

      {comparison ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {comparison.options.map((option) => {
            const fastest = best?.simulationId === option.simulationId;
            return (
              <article
                key={option.simulationId}
                className={`rounded-2xl border p-3 ${
                  fastest
                    ? "border-nq-success/60 bg-nq-success/10"
                    : "border-nq-border bg-nq-surface"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold text-nq-text">
                    {INTENT_LABELS[option.intent][language]}
                  </h3>
                  {fastest ? (
                    <span className="rounded-full bg-nq-success/15 px-2 py-1 text-xs font-semibold text-nq-success">
                      {vi ? "Chờ ít nhất" : "Lowest wait"}
                    </span>
                  ) : null}
                </div>

                {option.feasible && option.metrics ? (
                  <>
                    <p className="mt-2 flex items-center gap-2 text-sm text-nq-text">
                      <Clock3 aria-hidden="true" className="size-4 text-nq-primary" />
                      {vi ? "Chờ tối đa" : "Maximum wait"}: {option.metrics.maximumWaitMinutes}′
                      · {option.metrics.waveCount} {vi ? "đợt" : "wave(s)"}
                    </p>
                    <ol className="mt-3 space-y-2">
                      {option.assignments.map((assignment, index) => (
                        <li
                          key={assignment.taskId}
                          className="rounded-xl border border-nq-border/70 p-2 text-sm"
                        >
                          <p className="font-medium text-nq-text">
                            {vi ? `Khách ${index + 1}` : `Guest ${index + 1}`} · {assignment.staff.name}
                          </p>
                          <p className="text-nq-muted">
                            {formatInSalonTz(assignment.startsAt, timezone, "time")}–{formatInSalonTz(assignment.releasesAt, timezone, "time")} · {vi ? "Đợt" : "Wave"} {assignment.waveNumber}
                          </p>
                        </li>
                      ))}
                    </ol>
                    <Button
                      className="mt-3 w-full"
                      variant={fastest ? "primary" : "secondary"}
                      loading={isPending}
                      disabled={offline || recordedPlanId !== null}
                      onClick={() => recordPlan(option)}
                      leftIcon={<CheckCircle2 aria-hidden="true" className="size-4" />}
                    >
                      {recordedPlanId
                        ? vi ? "Đã lưu để xác nhận" : "Saved for confirmation"
                        : vi ? "Chọn kế hoạch này" : "Choose this plan"}
                    </Button>
                  </>
                ) : (
                  <p className="mt-3 flex items-start gap-2 rounded-xl bg-nq-warning/10 p-2 text-sm text-nq-warning">
                    <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    {vi
                      ? "Chưa chứng minh được phương án đầy đủ và an toàn."
                      : "No complete safe option was proven."}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      ) : null}

      <p className="mt-3 flex items-center gap-2 text-xs font-medium text-nq-muted">
        <ShieldCheck aria-hidden="true" className="size-4 text-nq-success" />
        {vi
          ? "So sánh không ghi booking. Lưu kế hoạch cũng chưa đổi lịch; chỉ bước xác nhận riêng mới áp dụng nguyên nhóm."
          : "Comparison does not write bookings. Saving a plan still changes no schedule; only the separate confirmation applies the whole party."}
      </p>

      {message ? (
        <p role="status" className="mt-3 text-sm text-nq-text">
          {message}
        </p>
      ) : null}
    </section>
  );
}
