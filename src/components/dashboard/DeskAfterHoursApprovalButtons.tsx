"use client";

import { Check, RotateCcw, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { decideDeskAfterHoursApprovalAction } from "@/shared/dashboard/decideDeskAfterHoursApprovalAction";

const ERROR_COPY: Record<string, string> = {
  expired: "Yêu cầu đã hết hạn. Tiếp tân cần gửi yêu cầu mới.",
  already_declined: "Yêu cầu này đã bị từ chối.",
  time_slot_taken: "Giờ này vừa có người đặt. Tiếp tân cần chọn giờ khác.",
  no_resource_available: "Không còn giường/phòng trống ở giờ này.",
  staff_consent_required: "Chưa xác minh được thợ đã đồng ý.",
  outside_hours: "Giờ này không còn nằm trong phạm vi ngoài giờ cho phép.",
};

export function DeskAfterHoursApprovalButtons({
  slug,
  approvalId,
  retryOnly = false,
}: {
  slug: string;
  approvalId: string;
  retryOnly?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const decide = (decision: "approved" | "declined") => {
    setError(null);
    startTransition(async () => {
      const result = await decideDeskAfterHoursApprovalAction({
        slug,
        approvalId,
        decision,
      });
      if (!result.ok) {
        setError(
          ERROR_COPY[result.error] ??
            "Không xử lý được yêu cầu. Kiểm tra lịch rồi thử lại.",
        );
        router.refresh();
        return;
      }
      router.refresh();
    });
  };

  return (
    <div>
      {retryOnly ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => decide("approved")}
          className="mt-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-nq-primary/50 px-3 text-sm font-semibold text-nq-primary disabled:cursor-wait disabled:opacity-60"
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
          {pending ? "Đang kiểm tra lại…" : "Kiểm tra lại và tạo lịch"}
        </button>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => decide("approved")}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-nq-success px-3 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60"
          >
            <Check className="h-4 w-4" aria-hidden />
            {pending ? "Đang kiểm tra…" : "Duyệt và tạo lịch"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => decide("declined")}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-nq-error/40 px-3 text-sm font-semibold text-nq-error disabled:cursor-wait disabled:opacity-60"
          >
            <X className="h-4 w-4" aria-hidden />
            Từ chối
          </button>
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-nq-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
