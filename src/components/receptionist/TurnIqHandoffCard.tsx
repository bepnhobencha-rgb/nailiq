"use client";

import { useRef, useState, useTransition } from "react";
import { CheckCircle2, Layers3, Play, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { formatInSalonTz } from "@/shared/lib/salonTime";
import type { TurnIqHandoffPlanView, TurnIqHandoffQueueView } from "@/shared/turniq/handoffReadModels";
import type {
  TurnIqHandoffCommandActionResult,
  TurnIqHandoffConfirmationActionInput,
  TurnIqHandoffPerformerActionInput,
  TurnIqHandoffRecommendationActionInput,
  TurnIqServerActionErrorCode,
} from "@/shared/turniq/serverContracts";

type PlanReadResult =
  | { ok: true; data: TurnIqHandoffPlanView }
  | { ok: false; code: TurnIqServerActionErrorCode };

type Props = {
  queue: TurnIqHandoffQueueView | null;
  errorCode: string | null;
  language: "en" | "vi";
  timezone: string;
  slug: string;
  canManage: boolean;
  offline: boolean;
  onRecommend: (input: TurnIqHandoffRecommendationActionInput) => Promise<TurnIqHandoffCommandActionResult>;
  onConfirm: (input: TurnIqHandoffConfirmationActionInput) => Promise<TurnIqHandoffCommandActionResult>;
  onPerformer: (input: TurnIqHandoffPerformerActionInput) => Promise<TurnIqHandoffCommandActionResult>;
  onLoadPlan: (input: { slug: string; handoffPlanId: string }) => Promise<PlanReadResult>;
  onRefresh: () => Promise<void>;
};

function errorCopy(code: string, vi: boolean): string {
  if (code === "stale_state") {
    return vi
      ? "Phân công hiện tại khác đề xuất hoặc lịch vừa đổi. TurnIQ không ghi đè; hãy làm mới và kiểm tra lịch."
      : "The committed assignment differs or the schedule changed. TurnIQ did not overwrite it; refresh and review the booking.";
  }
  if (code === "rollout_stage_blocked") return vi ? "Salon đang ở chế độ quan sát; chưa thể thay đổi lượt." : "The salon is in observation mode; turn changes are blocked.";
  if (code === "owner_confirmation_required") return vi ? "Owner/Admin cần duyệt ngoại lệ thợ khách yêu cầu." : "Owner/Admin must approve the requested-technician exception.";
  if (code === "feature_disabled") return vi ? "TurnIQ đang tắt cho salon này." : "TurnIQ is off for this salon.";
  return vi ? "Chưa nhận được kết quả. Thử lại sẽ dùng cùng mã để không tạo trùng." : "No result was received. Retry reuses the same command to prevent duplicates.";
}

export function TurnIqHandoffCard({
  queue,
  errorCode,
  language,
  timezone,
  slug,
  canManage,
  offline,
  onRecommend,
  onConfirm,
  onPerformer,
  onLoadPlan,
  onRefresh,
}: Props) {
  const vi = language === "vi";
  const [pending, startTransition] = useTransition();
  const [selectedBookingId, setSelectedBookingId] = useState(queue?.bookings[0]?.bookingId ?? "");
  const [plan, setPlan] = useState<TurnIqHandoffPlanView | null>(null);
  const [message, setMessage] = useState<string | null>(errorCode ? errorCopy(errorCode, vi) : null);
  const deviceId = useRef<string | null>(null);
  const sequence = useRef(0);
  const retries = useRef(new Map<string, unknown>());
  const bookings = queue?.bookings ?? [];
  const selected = bookings.find((row) => row.bookingId === selectedBookingId) ?? bookings[0] ?? null;
  const visiblePlan = plan?.bookingId === selected?.bookingId ? plan : null;

  function envelope() {
    deviceId.current ??= crypto.randomUUID();
    sequence.current += 1;
    return { commandId: crypto.randomUUID(), deviceId: deviceId.current, localSequence: sequence.current };
  }

  function command<T extends object>(key: string, create: () => T): T {
    const existing = retries.current.get(key) as T | undefined;
    if (existing) return existing;
    const next = create();
    retries.current.set(key, next);
    return next;
  }

  async function load(handoffPlanId: string, preserveMessage = false) {
    const result = await onLoadPlan({ slug, handoffPlanId });
    if (result.ok) setPlan(result.data);
    else if (!preserveMessage) setMessage(errorCopy(result.code, vi));
  }

  function recommend() {
    if (!selected || offline || !canManage) return;
    const key = `recommend:${selected.bookingId}`;
    const input = command<TurnIqHandoffRecommendationActionInput>(key, () => ({
      slug,
      bookingId: selected.bookingId,
      ...envelope(),
    }));
    setMessage(null);
    startTransition(() => void (async () => {
      try {
        const result = await onRecommend(input);
        if (!result.ok) {
          setMessage(errorCopy(result.code, vi));
          if (result.code !== "server_error") retries.current.delete(key);
          if (result.code === "stale_state") await onRefresh();
          return;
        }
        retries.current.delete(key);
        setMessage(vi ? "Đã lưu kế hoạch. Booking chưa bị đổi." : "Plan saved. The booking is still unchanged.");
        await load(result.result.handoffPlanId, true);
        await onRefresh().catch(() => undefined);
      } catch {
        setMessage(errorCopy("server_error", vi));
      }
    })());
  }

  function confirm() {
    if (!visiblePlan?.canConfirm || offline || !canManage) return;
    const key = `confirm:${visiblePlan.id}:${visiblePlan.stateVersion}`;
    const input = command<TurnIqHandoffConfirmationActionInput>(key, () => ({
      slug,
      handoffPlanId: visiblePlan.id,
      expectedStateVersion: visiblePlan.stateVersion,
      ...envelope(),
    }));
    setMessage(null);
    startTransition(() => void (async () => {
      try {
        const result = await onConfirm(input);
        if (!result.ok) {
          setMessage(errorCopy(result.code, vi));
          if (result.code !== "server_error") retries.current.delete(key);
          return;
        }
        retries.current.delete(key);
        setMessage(vi ? `Đã xác nhận và lưu ${result.result.fairnessReceiptIds.length} Fairness Receipt.` : `Confirmed with ${result.result.fairnessReceiptIds.length} Fairness Receipts.`);
        await load(result.result.handoffPlanId, true);
        await onRefresh().catch(() => undefined);
      } catch {
        setMessage(errorCopy("server_error", vi));
      }
    })());
  }

  function performer(performerId: string, nextCommand: "start" | "complete") {
    if (!visiblePlan || offline || !canManage) return;
    const key = `${nextCommand}:${performerId}`;
    const input = command<TurnIqHandoffPerformerActionInput>(key, () => ({
      slug,
      handoffPlanId: visiblePlan.id,
      performerId,
      command: nextCommand,
      ...envelope(),
    }));
    setMessage(null);
    startTransition(() => void (async () => {
      try {
        const result = await onPerformer(input);
        if (!result.ok) {
          setMessage(errorCopy(result.code, vi));
          if (result.code !== "server_error") retries.current.delete(key);
          return;
        }
        retries.current.delete(key);
        setMessage(nextCommand === "start" ? (vi ? "Đã bắt đầu đúng phần việc." : "The assigned work has started.") : (vi ? "Đã hoàn tất phần việc và ghi lượt đúng một lần." : "Work completed and the turn was recorded exactly once."));
        await load(result.result.handoffPlanId, true);
        await onRefresh().catch(() => undefined);
      } catch {
        setMessage(errorCopy("server_error", vi));
      }
    })());
  }

  if (bookings.length === 0 && !errorCode) return null;
  return (
    <section className="rounded-[var(--radius-nq-card)] border border-nq-primary/35 bg-nq-surface p-4 shadow-[var(--shadow-nq-card)]" aria-label={vi ? "TurnIQ đa dịch vụ" : "TurnIQ multi-service handoff"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex gap-3">
          <span className="rounded-2xl bg-nq-primary/15 p-2 text-nq-primary"><Layers3 aria-hidden="true" className="size-5" /></span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-nq-primary">TurnIQ Handoff</p>
            <h2 className="text-lg font-semibold text-nq-text">{vi ? "Một khách, nhiều dịch vụ, đúng lượt từng thợ" : "One guest, multiple services, each turn accounted for"}</h2>
            <p className="mt-1 text-sm text-nq-muted">{vi ? "TurnIQ không đổi giờ, ghế hoặc thợ đã commit nếu chưa có lệnh an toàn riêng." : "TurnIQ will not change committed time, resource, or technician without a dedicated safe command."}</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void onRefresh()} disabled={pending}><RefreshCw aria-hidden="true" className="mr-2 size-4" />{vi ? "Làm mới" : "Refresh"}</Button>
      </div>

      {selected ? <div className="mt-4 space-y-3">
        <label className="block text-sm font-medium text-nq-text">
          {vi ? "Lịch đa dịch vụ" : "Multi-service booking"}
          <select className="mt-1 w-full rounded-xl border border-nq-border bg-nq-bg px-3 py-2" value={selected.bookingId} onChange={(event) => { setSelectedBookingId(event.target.value); setPlan(null); setMessage(null); }}>
            {bookings.map((booking) => <option key={booking.bookingId} value={booking.bookingId}>{formatInSalonTz(booking.startsAt, timezone, "time")} · {booking.serviceSummary}</option>)}
          </select>
        </label>
        {selected.existingPlanId && !visiblePlan ? <Button variant="secondary" onClick={() => void load(selected.existingPlanId as string)} disabled={pending}>{vi ? "Mở kế hoạch" : "Open plan"}</Button> : null}
        {!selected.existingPlanId && !visiblePlan ? <Button onClick={recommend} disabled={!canManage || offline || pending}>{vi ? "Kiểm tra và tạo kế hoạch" : "Check and create plan"}</Button> : null}
      </div> : null}

      {visiblePlan ? <div className="mt-4 space-y-3 rounded-2xl border border-nq-border bg-nq-bg/60 p-3">
        <p className="text-sm font-medium text-nq-text">{visiblePlan.explanation}</p>
        {visiblePlan.performers.map((person) => <div key={person.performerId} className="rounded-xl border border-nq-border bg-nq-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><p className="font-semibold text-nq-text">{person.staff.name}</p><p className="text-xs text-nq-muted">{person.segmentCount} {vi ? "phần việc" : "service segment(s)"} · {person.status}</p></div>
            {person.status === "confirmed" ? <Button size="sm" onClick={() => performer(person.performerId, "start")} disabled={pending || offline || !canManage}><Play aria-hidden="true" className="mr-1 size-4" />{vi ? "Bắt đầu" : "Start"}</Button> : null}
            {person.status === "in_progress" ? <Button size="sm" onClick={() => performer(person.performerId, "complete")} disabled={pending || offline || !canManage}><CheckCircle2 aria-hidden="true" className="mr-1 size-4" />{vi ? "Hoàn tất" : "Complete"}</Button> : null}
          </div>
          <ul className="mt-2 space-y-1 text-sm text-nq-muted">{person.segments.map((segment) => <li key={segment.segmentId}>{formatInSalonTz(segment.startsAt, timezone, "time")} · {segment.serviceName}{segment.resourceName ? ` · ${segment.resourceName}` : ""}</li>)}</ul>
        </div>)}
        {visiblePlan.canConfirm ? <Button onClick={confirm} disabled={pending || offline || !canManage}>{vi ? "Xác nhận tất cả" : "Confirm all"}</Button> : null}
      </div> : null}
      {message ? <p role="status" className="mt-3 text-sm text-nq-muted">{message}</p> : null}
    </section>
  );
}
