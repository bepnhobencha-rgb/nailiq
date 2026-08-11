"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import {
  beginSalonPaymentGrace,
  pauseSalonTenant,
  resumeSalonTenant,
} from "@/shared/superadmin/superadminActions";
import type { SuperAdminSalonDetail } from "@/shared/superadmin/superadminTypes";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("vi-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Vancouver",
  }).format(new Date(value));
}

export function TenantStatusCard({ salon }: { salon: SuperAdminSalonDetail }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [graceDays, setGraceDays] = useState(7);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const paused = salon.archived_at != null;
  const inGrace = !paused && salon.subscription_status === "past_due" && salon.payment_grace_ends_at != null;

  function run(action: "pause" | "grace" | "resume") {
    setError(null);
    if (reason.trim().length < 3 || !confirmed) {
      setError("Nhập lý do và xác nhận phạm vi trước khi tiếp tục.");
      return;
    }
    startTransition(async () => {
      const result =
        action === "pause"
          ? await pauseSalonTenant(salon.id, "manual", reason)
          : action === "grace"
            ? await beginSalonPaymentGrace(salon.id, graceDays, reason)
            : await resumeSalonTenant(salon.id, reason);
      if (!result.ok) {
        setError(`Không thể cập nhật: ${result.error}`);
        return;
      }
      setReason("");
      setConfirmed(false);
      router.refresh();
    });
  }

  return (
    <section
      data-testid="superadmin-tenant-status"
      className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-nq-foreground">Trạng thái tenant</h2>
          <p className="mt-1 text-xs text-nq-muted">
            Chỉ điều khiển NailIQ. Không sửa website Wix, dữ liệu Wix hoặc tài khoản Square.
          </p>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-bold ${
            paused
              ? "border-red-500/45 bg-red-500/10 text-red-300"
              : inGrace
                ? "border-amber-500/45 bg-amber-500/10 text-amber-300"
                : "border-emerald-500/45 bg-emerald-500/10 text-emerald-300"
          }`}
        >
          {paused ? "ĐÃ TẠM DỪNG" : inGrace ? "ĐANG GIA HẠN THANH TOÁN" : "ĐANG HOẠT ĐỘNG"}
        </span>
      </div>

      <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-nq-muted">Subscription</dt><dd>{salon.subscription_status ?? "—"}</dd></div>
        <div><dt className="text-xs text-nq-muted">Hạn grace</dt><dd>{formatDate(salon.payment_grace_ends_at)}</dd></div>
        <div><dt className="text-xs text-nq-muted">Lý do khóa</dt><dd>{salon.tenant_pause_reason === "non_payment" ? "Chưa thanh toán" : salon.tenant_pause_reason === "manual" ? "Superadmin khóa thủ công" : "—"}</dd></div>
        <div><dt className="text-xs text-nq-muted">Khóa lúc</dt><dd>{formatDate(salon.archived_at)}</dd></div>
      </dl>

      <label className="mt-4 block">
        <span className="text-xs font-medium text-nq-muted">Lý do thao tác (bắt buộc, ghi vào audit log)</span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Ví dụ: Owner yêu cầu tạm dừng từ ngày…"
          className="mt-1.5 block w-full rounded-lg border border-nq-border/50 bg-nq-bg/85 px-3 py-2 text-sm text-nq-foreground outline-none focus-visible:border-nq-primary/80"
        />
      </label>

      <label className="mt-3 flex items-start gap-2 text-xs text-nq-muted">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5"
        />
        <span>Tôi xác nhận thao tác chỉ áp dụng cho NailIQ; Wix và Square không bị thay đổi.</span>
      </label>

      {error ? <p className="mt-3 text-xs text-nq-error">{error}</p> : null}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        {paused ? (
          <Button type="button" variant="primary" size="sm" disabled={pending} onClick={() => run("resume")}>
            {pending ? "Đang mở lại…" : "Mở lại tenant"}
          </Button>
        ) : (
          <>
            <Button type="button" variant="danger" size="sm" disabled={pending} onClick={() => run("pause")}>
              {pending ? "Đang xử lý…" : "Tạm dừng tenant ngay"}
            </Button>
            <label className="flex items-center gap-2 text-xs text-nq-muted">
              Grace
              <input
                type="number"
                min={1}
                max={30}
                value={graceDays}
                onChange={(event) => setGraceDays(Number(event.target.value))}
                className="w-16 rounded-lg border border-nq-border/50 bg-nq-bg/85 px-2 py-1.5 text-nq-foreground"
              />
              ngày
            </label>
            <Button type="button" variant="secondary" size="sm" disabled={pending || inGrace} onClick={() => run("grace")}>
              {inGrace ? "Grace đang chạy" : "Đánh dấu chưa thanh toán"}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
