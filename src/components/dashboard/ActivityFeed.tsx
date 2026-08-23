"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ArchivedBookingDrawer } from "@/components/dashboard/ArchivedBookingDrawer";
import type {
  ActivityItem,
  ActivityKind,
} from "@/shared/dashboard/loadActivityFeedAction";
import {
  loadArchivedBookingDetail,
  type ArchivedBookingDetail,
} from "@/shared/dashboard/loadArchivedBookingDetailAction";
import { refundCancelledBookingDepositRemaining } from "@/shared/dashboard/refundCancelledBookingDepositAction";
import { undoAiAction } from "@/shared/ai/undoAiAction";
import {
  activityItemsForTab,
  canOpenActivityBooking,
  terminalActivityBookingStatus,
  type ActivityFeedTab,
} from "@/shared/dashboard/activityFeedFilter";
import { activityTimeAgo } from "@/shared/dashboard/activityTime";
import { formatCurrency } from "@/shared/lib/currencyFormat";

const KIND_ICON: Record<ActivityKind, string> = {
  event: "🗓️",
  sms: "💬",
  email: "✉️",
  call: "📞",
  system: "⚙️",
  login: "🔑",
  ai: "🤖",
  watchdog: "🛡️",
  winback: "💌",
};

const TABS: { key: ActivityFeedTab; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "event", label: "Lịch hẹn" },
  { key: "cancelled", label: "Đã hủy" },
  { key: "no_show", label: "No-show" },
  { key: "sms", label: "SMS" },
  { key: "email", label: "Email" },
  { key: "call", label: "Cuộc gọi" },
  { key: "system", label: "Hệ thống" },
  { key: "login", label: "Đăng nhập" },
  { key: "ai", label: "AI" },
  { key: "watchdog", label: "Cảnh báo" },
  { key: "winback", label: "Giữ khách" },
];

function StatusBadge({ status, kind }: { status: string; kind: ActivityKind }) {
  if (kind === "call") {
    const ok = status === "completed";
    const bad = status === "failed";
    const active = status === "active";
    const cls = ok
      ? "bg-nq-success/15 text-nq-success"
      : bad
        ? "bg-nq-error/15 text-nq-error"
        : "bg-nq-warning/15 text-nq-warning";
    const label = ok
      ? "✓ Hoàn tất"
      : bad
        ? "✗ Lỗi"
        : active
          ? "● Đang gọi"
          : status === "interrupted"
            ? "! Gián đoạn"
            : "Đã kết thúc";
    return (
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls}`}
      >
        {label}
      </span>
    );
  }

  if (status === "saved") {
    return (
      <span className="rounded-full bg-nq-success/15 px-2 py-0.5 text-[10px] font-semibold text-nq-success">
        ✓ Đã lưu
      </span>
    );
  }
  const ok = status === "delivered";
  const bad = status === "failed" || status === "undelivered";
  const cls = ok
    ? "bg-nq-success/15 text-nq-success"
    : bad
      ? "bg-nq-error/15 text-nq-error"
      : "bg-nq-warning/15 text-nq-warning";
  const label = ok ? "✓ Đã nhận" : bad ? "✗ Lỗi" : "⏳ Đã gửi";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls}`}
    >
      {label}
    </span>
  );
}

export function ActivityFeed({
  slug,
  items,
  initialNowIso,
  timeZone,
  archivedBookingFeatureEnabled,
}: {
  slug: string;
  items: ActivityItem[];
  initialNowIso: string;
  timeZone: string;
  archivedBookingFeatureEnabled: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<ActivityFeedTab>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [archivedDrawerOpen, setArchivedDrawerOpen] = useState(false);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [archivedDetail, setArchivedDetail] =
    useState<ArchivedBookingDetail | null>(null);
  const archivedRequestRef = useRef(0);
  const archivedRefundRequestRef = useRef<{
    key: string;
    requestId: string;
  } | null>(null);
  const [archivedRefundPending, startArchivedRefund] = useTransition();
  const [archivedRefundFeedback, setArchivedRefundFeedback] = useState<{
    kind: "idle" | "success" | "warning" | "error";
    message: string | null;
  }>({ kind: "idle", message: null });
  const [undoneIds, setUndoneIds] = useState<Set<string>>(new Set());
  const [undoing, startUndo] = useTransition();
  // The serialized server instant guarantees identical SSR/client markup.
  // Start a live clock only after hydration has committed.
  const [nowMs, setNowMs] = useState(() => Date.parse(initialNowIso));
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Read/unread like email: items newer than the last time the owner opened the
  // log show BOLD; already-seen ones are dimmed. Capture the PREVIOUS last-seen
  // marker on mount (for styling), then advance it to now so this same set reads
  // as "seen" next visit (and the bell badge clears).
  const seenKey = `activity-seen:${slug}`;
  // 0 = treat everything as unread (bold) until we've read the persisted marker.
  const [prevSeenMs, setPrevSeenMs] = useState<number>(0);
  const initedRef = useRef(false);
  useEffect(() => {
    // Run the read-then-advance ONCE, even under React StrictMode's double-invoke
    // (otherwise the 2nd run reads the marker the 1st run just wrote → all dim).
    if (initedRef.current) return;
    initedRef.current = true;
    try {
      const prev = window.localStorage.getItem(seenKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPrevSeenMs(prev ? Date.parse(prev) : 0);
      // Advance the marker AFTER capturing the previous value, so the items shown
      // in THIS view read as seen (dimmed) on the next visit.
      window.localStorage.setItem(seenKey, new Date().toISOString());
    } catch {
      /* storage blocked → everything reads as seen */
    }
  }, [seenKey]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {
      all: items.length,
      cancelled: activityItemsForTab(items, "cancelled").length,
      no_show: activityItemsForTab(items, "no_show").length,
    };
    for (const it of items) c[it.kind] = (c[it.kind] ?? 0) + 1;
    return c;
  }, [items]);

  const shown = activityItemsForTab(items, tab);

  const closeArchivedDrawer = () => {
    if (archivedRefundPending) return;
    archivedRequestRef.current += 1;
    setArchivedDrawerOpen(false);
    setArchivedRefundFeedback({ kind: "idle", message: null });
  };

  const openArchivedBooking = async (item: ActivityItem) => {
    if (archivedRefundPending) return;
    const terminalStatus = terminalActivityBookingStatus(item);
    if (!archivedBookingFeatureEnabled || !terminalStatus || !item.bookingId) {
      return;
    }

    const requestId = archivedRequestRef.current + 1;
    archivedRequestRef.current = requestId;
    setArchivedDrawerOpen(true);
    setArchivedLoading(true);
    setArchivedError(null);
    setArchivedDetail(null);
    setArchivedRefundFeedback({ kind: "idle", message: null });

    try {
      const result = await loadArchivedBookingDetail(slug, item.bookingId);
      if (archivedRequestRef.current !== requestId) return;
      if (result.ok) {
        setArchivedDetail(result.detail);
      } else {
        const message =
          result.error === "feature_disabled"
            ? "Tính năng khôi phục lịch lưu trữ đang tắt cho salon này."
            : result.error === "not_found"
              ? "Lịch này không còn ở trạng thái đã huỷ hoặc không đến. Hãy tải lại trang để xem trạng thái mới nhất."
              : result.error === "unauthorized" || result.error === "forbidden"
                ? "Bạn không có quyền xem chi tiết lịch này."
                : result.error === "invalid_booking"
                  ? "Mã lịch không hợp lệ."
                  : "Không thể tải chi tiết lịch. Vui lòng thử lại.";
        setArchivedError(message);
      }
    } catch {
      if (archivedRequestRef.current === requestId) {
        setArchivedError("Không thể tải chi tiết lịch. Vui lòng thử lại.");
      }
    } finally {
      if (archivedRequestRef.current === requestId) {
        setArchivedLoading(false);
      }
    }
  };

  const continueArchivedRecovery = (detail: ArchivedBookingDetail) => {
    const params = new URLSearchParams({
      recover: detail.id,
      recoveryKind:
        detail.status === "no_show" ? "no_show_walkin" : "cancelled_rebook",
    });
    closeArchivedDrawer();
    router.push(
      `/dashboard/${encodeURIComponent(slug)}/center?${params.toString()}`,
    );
  };

  const refundArchivedBookingRemaining = (detail: ArchivedBookingDetail) => {
    const amount = detail.depositRefund?.remainingRefundableCents ?? 0;
    if (
      detail.status !== "cancelled" ||
      detail.depositRefund?.availability !== "available" ||
      !Number.isSafeInteger(amount) ||
      amount <= 0
    ) {
      setArchivedRefundFeedback({
        kind: "error",
        message: "Số tiền có thể hoàn đã thay đổi. Vui lòng tải lại chi tiết.",
      });
      return;
    }

    const key = `${detail.id}:${amount}`;
    if (archivedRefundRequestRef.current?.key !== key) {
      archivedRefundRequestRef.current = {
        key,
        requestId: window.crypto.randomUUID(),
      };
    }
    const requestId = archivedRefundRequestRef.current.requestId;
    const archivedViewRequestId = archivedRequestRef.current;
    const isCurrentRefundView = () =>
      archivedRequestRef.current === archivedViewRequestId;

    startArchivedRefund(async () => {
      setArchivedRefundFeedback({
        kind: "warning",
        message: "Đang gửi yêu cầu hoàn tiền. Không đóng hoặc gửi mã mới…",
      });
      try {
        const result = await refundCancelledBookingDepositRemaining(slug, {
          bookingId: detail.id,
          requestId,
          expectedRemainingCents: amount,
        });
        if (result.ok) {
          if (!isCurrentRefundView()) return;
          if (archivedRefundRequestRef.current?.requestId === requestId) {
            archivedRefundRequestRef.current = null;
          }
          setArchivedDetail((current) =>
            current?.id === detail.id && current.depositRefund
              ? {
                  ...current,
                  depositRefund: {
                    ...current.depositRefund,
                    refundedCents: current.depositRefund.capturedCents,
                    reservedCents: 0,
                    remainingRefundableCents: 0,
                    availability: "fully_refunded",
                  },
                }
              : current,
          );
          try {
            const refreshed = await loadArchivedBookingDetail(slug, detail.id);
            if (refreshed.ok && isCurrentRefundView()) {
              setArchivedDetail((current) =>
                current?.id === detail.id ? refreshed.detail : current,
              );
            }
          } catch {
            // The acknowledged payment result is authoritative. Keep the safe
            // full-refund projection above if the follow-up read is unavailable.
          }
          if (!isCurrentRefundView()) return;
          setArchivedRefundFeedback({
            kind: "success",
            message: `Đã hoàn ${formatCurrency(amount, detail.currencyCode)}. Booking vẫn ở trạng thái đã huỷ.`,
          });
          return;
        }

        if (result.error === "reconciliation_required") {
          if (!isCurrentRefundView()) return;
          setArchivedRefundFeedback({
            kind: "warning",
            message:
              "Chưa thể xác nhận kết quả với provider. Mã yêu cầu hiện tại đã được giữ nguyên; chỉ bấm lại nút này để đối soát, không tạo yêu cầu mới.",
          });
          return;
        }

        if (!isCurrentRefundView()) return;
        if (archivedRefundRequestRef.current?.requestId === requestId) {
          archivedRefundRequestRef.current = null;
        }
        const shouldRefresh = [
          "refund_changed",
          "request_conflict",
          "not_refundable",
          "not_cancelled",
        ].includes(result.error);
        if (shouldRefresh) {
          const refreshed = await loadArchivedBookingDetail(slug, detail.id);
          if (refreshed.ok && isCurrentRefundView()) {
            setArchivedDetail((current) =>
              current?.id === detail.id ? refreshed.detail : current,
            );
          }
        }
        const message = result.error === "refund_changed"
          ? "Số tiền còn lại đã thay đổi. Hãy kiểm tra lại trước khi xác nhận."
          : result.error === "not_refundable"
            ? "Booking này không còn khoản tiền cọc có thể hoàn."
            : result.error === "not_cancelled"
              ? "Booking không còn ở trạng thái đã huỷ nên chưa hoàn tiền."
              : result.error === "provider_failed"
                ? "Provider đã từ chối yêu cầu hoàn tiền. Không có khoản hoàn nào được ghi nhận."
                : result.error === "unauthorized" ||
                    result.error === "forbidden"
                  ? "Chỉ Owner/Admin đã đăng nhập mới được hoàn tiền."
                  : result.error === "feature_disabled"
                    ? "Tính năng hoàn tiền đang tắt cho salon này."
                    : "Không thể hoàn tiền. Vui lòng kiểm tra lại trước khi thử lần nữa.";
        if (!isCurrentRefundView()) return;
        setArchivedRefundFeedback({ kind: "error", message });
      } catch {
        // The provider/DB may already have committed even if the action HTTP
        // response was lost. Keep the same request UUID for an exact replay.
        if (isCurrentRefundView()) {
          setArchivedRefundFeedback({
            kind: "warning",
            message:
              "Mất phản hồi sau khi gửi. Mã yêu cầu đã được giữ nguyên; bấm lại đúng nút này để kiểm tra, không tạo yêu cầu mới.",
          });
        }
      }
    });
  };

  return (
    <>
      <section className="rounded-2xl border border-nq-border bg-nq-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-nq-foreground">
              Nhật ký hoạt động
            </h1>
            <p className="mt-0.5 text-xs text-nq-muted">
              Tin nhắn, email, cuộc gọi và thay đổi lịch — xem lại bất cứ lúc
              nào. Bấm vào một mục lịch đang hoạt động để mở lịch thật; lịch đã
              huỷ hoặc không đến sẽ mở bản chi tiết chỉ xem. Nhật ký giữ tối đa
              400 hồ sơ đã huỷ/no-show gần nhất.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              data-testid={`activity-tab-${t.key}`}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === t.key
                  ? "bg-nq-primary text-nq-bg"
                  : "bg-nq-border/30 text-nq-muted hover:text-nq-foreground"
              }`}
            >
              {t.label}
              {counts[t.key] ? (
                <span className="ml-1 opacity-70">{counts[t.key]}</span>
              ) : null}
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <p className="mt-6 text-sm italic text-nq-muted">
            Chưa có hoạt động nào.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-nq-border/50">
            {shown.map((it) => {
              const unread = Date.parse(it.when) > prevSeenMs;
              const terminalStatus = terminalActivityBookingStatus(it);
              const canOpenBooking = canOpenActivityBooking(
                it,
                archivedBookingFeatureEnabled,
              );
              const inner = (
                <div
                  className={`flex items-start gap-3 py-3 ${unread ? "" : "opacity-55"}`}
                >
                  <span aria-hidden className="relative mt-0.5 text-base">
                    {KIND_ICON[it.kind]}
                    {unread ? (
                      <span className="absolute -left-2 top-1.5 h-1.5 w-1.5 rounded-full bg-nq-primary" />
                    ) : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`text-sm text-nq-foreground ${unread ? "font-semibold" : "font-normal"}`}
                      >
                        {it.title}
                      </span>
                      {it.status ? (
                        <StatusBadge status={it.status} kind={it.kind} />
                      ) : null}
                      {canOpenBooking ? (
                        <span className="text-[10px] font-semibold text-nq-primary">
                          {terminalStatus ? "Xem chi tiết →" : "Xem lịch →"}
                        </span>
                      ) : null}
                    </div>
                    {it.subtitle ? (
                      <p
                        className={`mt-0.5 text-xs text-nq-muted ${open === it.id ? "" : "truncate"}`}
                      >
                        {it.subtitle}
                      </p>
                    ) : null}
                    {(it.kind === "call" ||
                      it.kind === "ai" ||
                      it.kind === "watchdog" ||
                      it.kind === "winback") &&
                    it.transcript ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          setOpen(open === it.id ? null : it.id);
                        }}
                        className="mt-1 text-[11px] font-semibold text-nq-primary"
                      >
                        {open === it.id
                          ? it.kind === "call"
                            ? "Ẩn bản ghi"
                            : "Ẩn chi tiết"
                          : it.kind === "call"
                            ? "Xem bản ghi cuộc gọi"
                            : "Xem chi tiết →"}
                      </button>
                    ) : null}
                    {open === it.id && it.transcript ? (
                      <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-xl bg-nq-border/20 p-3 text-[11px] leading-relaxed text-nq-foreground">
                        {it.transcript}
                      </pre>
                    ) : null}
                    {it.undoActionId && !undoneIds.has(it.undoActionId) ? (
                      <button
                        type="button"
                        disabled={undoing}
                        onClick={(e) => {
                          e.preventDefault();
                          const actionId = it.undoActionId!;
                          startUndo(async () => {
                            const r = await undoAiAction(slug, actionId);
                            if (r.ok)
                              setUndoneIds((s) => new Set(s).add(actionId));
                          });
                        }}
                        className="mt-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700 transition-colors hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400"
                      >
                        ↩ Undo (60 phút)
                      </button>
                    ) : it.undoActionId && undoneIds.has(it.undoActionId) ? (
                      <span className="mt-1.5 inline-block text-[11px] text-nq-muted">
                        ↩ Đã undo
                      </span>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-[10px] tabular-nums text-nq-muted">
                    {activityTimeAgo(it.when, nowMs, timeZone)}
                  </span>
                </div>
              );

              return (
                <li key={it.id} data-testid={`activity-row-${it.kind}`}>
                  {canOpenBooking && terminalStatus ? (
                    <button
                      type="button"
                      onClick={() => void openArchivedBooking(it)}
                      className="block w-full rounded-lg text-left transition-colors hover:bg-nq-border/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
                      data-testid="activity-open-archived-booking"
                    >
                      {inner}
                    </button>
                  ) : canOpenBooking ? (
                    <Link
                      href={`/dashboard/${encodeURIComponent(slug)}/center?${it.bookingDate ? `date=${encodeURIComponent(it.bookingDate)}&` : ""}booking=${encodeURIComponent(it.bookingId ?? "")}`}
                      className="block rounded-lg transition-colors hover:bg-nq-border/15"
                    >
                      {inner}
                    </Link>
                  ) : (
                    inner
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ArchivedBookingDrawer
        isOpen={archivedDrawerOpen}
        onClose={closeArchivedDrawer}
        detail={archivedDetail}
        loading={archivedLoading}
        error={archivedError}
        featureEnabled={archivedBookingFeatureEnabled}
        timeZone={timeZone}
        onRecover={continueArchivedRecovery}
        refundLoading={archivedRefundPending}
        refundFeedback={archivedRefundFeedback}
        onRefundRemaining={refundArchivedBookingRemaining}
      />
    </>
  );
}
