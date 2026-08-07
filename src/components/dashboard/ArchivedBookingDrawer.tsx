"use client";

import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import type { ArchivedBookingDetail } from "@/shared/dashboard/loadArchivedBookingDetailAction";
import { formatCurrency } from "@/shared/lib/currencyFormat";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  detail: ArchivedBookingDetail | null;
  loading: boolean;
  error: string | null;
  featureEnabled: boolean;
  timeZone: string;
  onRecover: (detail: ArchivedBookingDetail) => void;
};

function formatDateTime(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "—";
  try {
    return new Intl.DateTimeFormat("vi-CA", {
      timeZone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString();
  }
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 border-b border-nq-border/50 py-3 last:border-0">
      <dt className="text-xs font-medium text-nq-muted">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-nq-foreground">
        {value || "—"}
      </dd>
    </div>
  );
}

function noShowChargeLabel(status: string | null): string {
  const labels: Record<string, string> = {
    saved: "Đã lưu thẻ — chưa thu",
    charged: "Đã thu",
    failed: "Thu thất bại",
    waived: "Đã miễn phí",
    refunded: "Đã hoàn tiền",
    removed_by_customer: "Khách đã gỡ thẻ",
  };
  return status ? (labels[status] ?? "Chưa xác định") : "Chưa thu";
}

export function ArchivedBookingDrawer({
  isOpen,
  onClose,
  detail,
  loading,
  error,
  featureEnabled,
  timeZone,
  onRecover,
}: Props) {
  const statusLabel = detail?.status === "no_show" ? "Không đến" : "Đã huỷ";
  const price = detail
    ? formatCurrency(detail.priceCents, detail.currencyCode)
    : null;
  const noShowFee = detail
    ? formatCurrency(detail.noShowFeeCents, detail.currencyCode)
    : null;
  const recoveryLabel =
    detail?.status === "no_show"
      ? "Khách đến trễ — Tạo Walk-in"
      : "Đặt lại lịch";
  const recoveryTraceLabel = detail?.recoveredBooking
    ? detail.status === "no_show"
      ? "No-show → đã tạo Walk-in mới"
      : "Đã huỷ → đã tạo lịch mới"
    : null;

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title="Chi tiết lịch đã lưu trữ"
      description="Chế độ chỉ xem — chưa có dữ liệu nào được thay đổi."
      size="md"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose}>
            Đóng
          </Button>
          {detail && featureEnabled ? (
            <Button
              onClick={() => onRecover(detail)}
              disabled={Boolean(detail.recoveredBooking)}
              data-testid="archived-booking-recover"
            >
              {detail.recoveredBooking ? "Đã tạo hồ sơ mới" : recoveryLabel}
            </Button>
          ) : null}
        </div>
      }
    >
      {loading ? (
        <div
          className="flex min-h-40 items-center justify-center text-sm text-nq-muted"
          data-testid="archived-booking-loading"
        >
          Đang tải chi tiết lịch…
        </div>
      ) : error ? (
        <div
          role="alert"
          className="rounded-xl border border-nq-error/30 bg-nq-error/10 p-4 text-sm text-nq-error"
          data-testid="archived-booking-error"
        >
          {error}
        </div>
      ) : detail ? (
        <div data-testid="archived-booking-detail">
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-nq-border/20 p-3">
            <div>
              <p className="text-xs text-nq-muted">Trạng thái hiện tại</p>
              <p className="mt-0.5 text-sm font-semibold text-nq-foreground">
                {statusLabel}
              </p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                detail.status === "no_show"
                  ? "bg-nq-warning/15 text-nq-warning"
                  : "bg-nq-error/15 text-nq-error"
              }`}
            >
              {statusLabel}
            </span>
          </div>

          <dl>
            <DetailRow label="Khách" value={detail.clientName} />
            <DetailRow label="Điện thoại" value={detail.clientPhoneMasked} />
            <DetailRow
              label="Thời gian"
              value={formatDateTime(detail.startTimeUtc, timeZone)}
            />
            <DetailRow label="Dịch vụ" value={detail.serviceName} />
            <DetailRow label="Nhân viên" value={detail.staffName} />
            <DetailRow label="Giá lịch" value={price} />
            <DetailRow
              label="Nguồn"
              value={detail.bookingChannel || detail.source}
            />
            {detail.status === "no_show" || detail.noShowFeeCents != null ? (
              <>
                <DetailRow label="Phí no-show" value={noShowFee} />
                <DetailRow
                  label="Thu phí"
                  value={noShowChargeLabel(detail.noShowChargeStatus)}
                />
              </>
            ) : null}
            <DetailRow label="Ghi chú" value={detail.clientNotes} />
          </dl>

          {detail.recoveredBooking && recoveryTraceLabel ? (
            <div
              className="mt-4 rounded-xl border border-nq-success/30 bg-nq-success/10 p-3"
              data-testid="archived-booking-recovery-trace"
            >
              <p className="text-sm font-semibold text-nq-success">
                {recoveryTraceLabel}
              </p>
              <p className="mt-1 text-xs text-nq-muted">
                Lịch thay thế đã được tạo lúc{" "}
                {formatDateTime(detail.recoveredBooking.createdAt, timeZone)}.
                Không thể tạo thêm một lịch thay thế từ cùng lịch gốc.
              </p>
            </div>
          ) : null}

          <p className="mt-4 rounded-xl border border-nq-border bg-nq-bg/30 p-3 text-xs leading-relaxed text-nq-muted">
            Nút “{recoveryLabel}” chỉ chuyển đến Trung tâm lễ tân bằng mã lịch.
            Việc tạo lịch thay thế vẫn cần được xác nhận ở bước tiếp theo.
          </p>
        </div>
      ) : null}
    </Drawer>
  );
}
