"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  acknowledgeBookingManagementRequest,
  replayExistingBookingManagementRequest,
  stableBookingManagementRequestId,
} from "@/shared/booking/bookingManagementRequestId";
import { isCommittedCancellationPaymentPending } from "@/shared/payments/paymentOutagePresentation";
import { GroupReplacementOptions } from "@/components/booking/GroupReplacementOptions";

type Preview = {
  ok: boolean;
  code?: string;
  startPast?: boolean;
  withinWindow?: boolean;
  willCharge?: boolean;
  policyLockedByReschedule?: boolean;
  feeCents?: number;
  last4?: string | null;
  brand?: string | null;
  currency?: string;
  salonSlug?: string | null;
  groupMemberAction?: "cancel_attendance" | "decline_invitation" | null;
};

type CancelResponse = {
  ok?: boolean;
  code?: string;
  salonSlug?: string | null;
  feeCharged?: boolean;
  feeCents?: number;
  currency?: string;
  bookingCommitted?: boolean;
  feeStatus?: "approval_required" | "pending_provider" | "unknown" | "succeeded" | "definite_failure" | "not_applicable";
};

function fmtMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

export default function CancelBookingPage() {
  const searchParams = useSearchParams();
  const token = searchParams?.get("token") ?? "";
  const language = searchParams?.get("lang") === "vi" ? "vi" : "en";
  const cancelInFlight = useRef(false);
  const [replacementAccepted, setReplacementAccepted] = useState(false);
  const onReplacementStatus = useCallback((status: "available" | "pending" | "accepted" | "unavailable") => {
    setReplacementAccepted(status === "accepted");
  }, []);
  const [state, setState] = useState<
    "preview" | "idle" | "loading" | "done" | "error" | "blocked" | "payment_pending"
  >(token ? "preview" : "error");
  const [code, setCode] = useState(token ? "" : "missing_token");
  const [salonSlug, setSalonSlug] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [feeCharged, setFeeCharged] = useState<{ cents: number; currency: string } | null>(null);
  const [feeApprovalRequired, setFeeApprovalRequired] = useState<{ cents: number; currency: string } | null>(null);
  const [pendingFee, setPendingFee] = useState<{ cents: number; currency: string; status: string } | null>(null);
  const applyCommittedPaymentPending = useCallback((json: CancelResponse): void => {
    setPendingFee({
      cents: typeof json.feeCents === "number" ? json.feeCents : 0,
      currency: json.currency ?? "USD",
      status: json.feeStatus ?? "unknown",
    });
    setState("payment_pending");
  }, []);
  const applyCommittedCancellation = useCallback((json: CancelResponse): void => {
    if (json.salonSlug) setSalonSlug(json.salonSlug);
    if (json.feeCharged && typeof json.feeCents === "number") {
      setFeeCharged({ cents: json.feeCents, currency: json.currency ?? "USD" });
    }
    if (json.feeStatus === "approval_required" && typeof json.feeCents === "number") {
      setFeeApprovalRequired({ cents: json.feeCents, currency: json.currency ?? "USD" });
    }
    setState("done");
  }, []);

  // Fetch what a cancel would do (past appointment? late-cancel fee?) so the
  // customer sees the fee BEFORE confirming.
  useEffect(() => {
    if (!token) return;
    let alive = true;
    (async () => {
      try {
        const intent = { action: "cancel" as const, token };
        const replay = await replayExistingBookingManagementRequest(intent, async (requestId) => {
          const response = await fetch("/api/booking/cancel-action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, requestId }),
          });
          const body = await response.json() as CancelResponse;
          return { acknowledged: response.ok && body.ok === true, value: { response, body } };
        });
        if (!alive) return;
        if (replay) {
          if (replay.value.response.ok && replay.value.body.ok) {
            applyCommittedCancellation(replay.value.body);
          } else if (isCommittedCancellationPaymentPending(replay.value.body)) {
            applyCommittedPaymentPending(replay.value.body);
          } else {
            setState("error");
            setCode(replay.value.body.code ?? "management_unavailable");
          }
          return;
        }
        const res = await fetch(
          `/api/booking/cancel-action?token=${encodeURIComponent(token)}`,
        );
        const json = (await res.json()) as Preview;
        if (!alive) return;
        if (!json.ok) {
          setState("error");
          setCode(json.code ?? "unknown");
          return;
        }
        setPreview(json);
        if (json.salonSlug) setSalonSlug(json.salonSlug);
        setState(json.startPast ? "blocked" : "idle");
      } catch {
        if (!alive) return;
        setState("error");
        setCode("server_error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [applyCommittedCancellation, applyCommittedPaymentPending, token]);

  async function handleCancel() {
    if (cancelInFlight.current || replacementAccepted) return;
    if (!token) { setState("error"); setCode("missing_token"); return; }
    cancelInFlight.current = true;
    setState("loading");

    try {
      const intent = { action: "cancel" as const, token };
      const requestId = await stableBookingManagementRequestId(intent);
      const res = await fetch("/api/booking/cancel-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, requestId }),
      });
      const json = (await res.json()) as CancelResponse;
      if (json.ok) {
        await acknowledgeBookingManagementRequest(intent);
        applyCommittedCancellation(json);
      } else if (isCommittedCancellationPaymentPending(json)) {
        applyCommittedPaymentPending(json);
      } else if (json.code === "too_late") {
        setState("blocked");
      } else {
        setState("error");
        setCode(json.code ?? "unknown");
      }
    } catch {
      setState("error");
      setCode("server_error");
    } finally {
      cancelInFlight.current = false;
    }
  }

  if (state === "preview") {
    return (
      <Shell>
        <div className="text-center">
          <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-nq-border border-t-nq-muted" />
          <p className="mt-4 text-sm text-nq-muted">Loading… / Đang tải…</p>
        </div>
      </Shell>
    );
  }

  if (state === "done") {
    return (
      <Shell>
        <div className="text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-nq-border bg-nq-surface">
            <svg className="h-8 w-8 text-nq-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-white">Appointment Cancelled</h1>
          <p className="mt-3 text-sm text-nq-muted">
            Your appointment has been cancelled. We hope to see you again soon.
          </p>
          {feeCharged && (
            <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
              A late-cancellation fee of{" "}
              <b>{fmtMoney(feeCharged.cents, feeCharged.currency)}</b> was charged
              to your card on file.
              <br />
              <span className="text-amber-300/80">
                Đã tính phí huỷ trễ {fmtMoney(feeCharged.cents, feeCharged.currency)}{" "}
                vào thẻ đã lưu.
              </span>
            </p>
          )}
          {feeApprovalRequired && (
            <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
              No fee was charged today. A possible late-cancellation fee of{" "}
              <b>{fmtMoney(feeApprovalRequired.cents, feeApprovalRequired.currency)}</b>{" "}
              requires salon Owner/Admin review.
              <br />
              <span className="text-amber-300/80">
                Hôm nay chưa thu phí. Phí huỷ trễ có thể áp dụng{" "}
                {fmtMoney(feeApprovalRequired.cents, feeApprovalRequired.currency)} và phải được
                Owner/Admin của salon duyệt.
              </span>
            </p>
          )}
          {salonSlug && (
            <div className="mt-6">
              <a
                href={`/${salonSlug}?ref=cancel_page`}
                className="inline-block rounded-xl border border-nq-border/60 bg-nq-surface px-6 py-3 text-sm font-medium text-white transition hover:bg-nq-border/20"
              >
                📅 Book another time
              </a>
            </div>
          )}
        </div>
      </Shell>
    );
  }

  if (state === "payment_pending") {
    const fee = pendingFee && pendingFee.cents > 0
      ? fmtMoney(pendingFee.cents, pendingFee.currency)
      : null;
    const pendingStatus = pendingFee?.status === "pending_provider"
      ? "Provider processing / Nhà cung cấp đang xử lý"
      : "Outcome unknown / Kết quả chưa xác định";
    return (
      <Shell>
        <div className="text-center">
          <h1 className="text-xl font-semibold text-white">Cancellation received</h1>
          <p className="mt-3 text-sm text-nq-muted">
            Your appointment is cancelled, but the payment result{fee ? ` for ${fee}` : ""} is
            still being verified. Do not submit another payment or cancellation.
          </p>
          <p className="mt-2 text-sm text-nq-muted/80">
            Lịch hẹn đã được huỷ, nhưng kết quả thanh toán{fee ? ` ${fee}` : ""} đang được
            đối soát. Không thanh toán hoặc gửi yêu cầu huỷ mới.
          </p>
          <p className="mt-3 text-xs text-amber-300/90">{pendingStatus}</p>
          <button
            type="button"
            onClick={() => void handleCancel()}
            className="mt-6 rounded-xl border border-nq-border/60 px-5 py-3 text-sm text-white"
          >
            Check the same payment / Kiểm tra giao dịch này
          </button>
        </div>
      </Shell>
    );
  }

  // Past-start: the online link can no longer cancel; direct them to the salon.
  if (state === "blocked") {
    return (
      <Shell>
        <div className="text-center">
          <h1 className="text-xl font-semibold text-white">Please Call the Salon</h1>
          <p className="mt-3 text-sm text-nq-muted">
            This appointment can no longer be cancelled online. Please contact the
            salon directly.
          </p>
          <p className="mt-2 text-sm text-nq-muted/80">
            Lịch hẹn này không thể huỷ online nữa. Vui lòng gọi trực tiếp cho tiệm.
          </p>
          {salonSlug && (
            <div className="mt-6">
              <a
                href={`/${salonSlug}`}
                className="inline-block rounded-xl border border-nq-border/60 bg-nq-surface px-6 py-3 text-sm font-medium text-white transition hover:bg-nq-border/20"
              >
                View salon
              </a>
            </div>
          )}
        </div>
      </Shell>
    );
  }

  const errorMessages: Record<string, string> = {
    missing_token: "This cancellation link is invalid.",
    token_invalid: "This link has already been used or has expired.",
    booking_not_cancellable: "This appointment cannot be cancelled at this time.",
    server_error: "Something went wrong. Please contact the salon directly.",
  };

  if (state === "error") {
    return (
      <Shell>
        <div className="text-center">
          <h1 className="text-xl font-semibold text-white">{replacementAccepted ? "Replacement confirmed / Đã có người thay" : "Unable to Cancel"}</h1>
          {!replacementAccepted && <p className="mt-3 text-sm text-nq-muted">{errorMessages[code] ?? "An unexpected error occurred."}</p>}
          {token && <GroupReplacementOptions token={token} language={language} onStatusChange={onReplacementStatus} />}
        </div>
      </Shell>
    );
  }

  const willCharge = preview?.willCharge === true && (preview?.feeCents ?? 0) > 0;
  const feeStr = willCharge
    ? fmtMoney(preview!.feeCents!, preview!.currency ?? "USD")
    : "";

  return (
    <Shell>
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-white">
          {replacementAccepted ? "Replacement confirmed / Đã có người thay"
            : preview?.groupMemberAction === "decline_invitation" ? "Decline invitation / Từ chối lời mời"
            : "Cancel Appointment / Hủy lịch hẹn"}
        </h1>
        <p className="mt-3 text-sm text-nq-muted">
          {replacementAccepted ? "The rest of the group keeps their appointments. / Nhóm còn lại vẫn giữ lịch."
            : "Review the options below before confirming. / Xem các lựa chọn trước khi xác nhận."}
        </p>

        {preview?.groupMemberAction && <GroupReplacementOptions token={token} language={language} onStatusChange={onReplacementStatus} />}

        {preview?.groupMemberAction && !replacementAccepted && (
          <p className="mt-4 rounded-xl border border-nq-border p-3 text-sm text-nq-muted">
            This action changes only your attendance. No fee is authorized for this individual group cancellation; no card is charged here.
            <br />
            Chỉ thay đổi việc tham gia của bạn. Chính sách hiện tại chưa cho phép thu phí hủy riêng thành viên này; không trừ tiền tại đây.
          </p>
        )}

        {willCharge && (
          <div className="mt-5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-left">
            <p className="text-sm font-semibold text-amber-300">
              ⚠ Late-cancellation fee / Phí huỷ trễ
            </p>
            <p className="mt-1 text-sm text-amber-200/90">
              A possible late-cancellation fee of <b>{feeStr}</b> requires salon Owner/Admin review. Confirming cancellation does not charge your card.
            </p>
            <p className="mt-1 text-sm text-amber-200/70">
              Phí hủy trễ dự kiến <b>{feeStr}</b> cần được chủ tiệm hoặc quản trị viên duyệt. Xác nhận hủy không tự trừ tiền.
            </p>
            {preview?.policyLockedByReschedule && (
              <p className="mt-2 text-xs text-amber-200/80">
                This appointment was rescheduled after entering the cancellation
                window, so the original fee condition still applies. · Lịch này đã
                được đổi sau khi vào thời hạn tính phí, nên điều kiện phí ban đầu
                vẫn được giữ.
              </p>
            )}
          </div>
        )}

        {!replacementAccepted && <div className="mt-8 flex flex-col gap-3">
          <button
            onClick={handleCancel}
            disabled={state === "loading"}
            className="w-full rounded-xl border border-red-500/40 bg-red-500/10 py-3 text-sm font-medium text-red-400 transition hover:bg-red-500/20 disabled:opacity-50"
          >
            {state === "loading"
              ? "Cancelling…"
              : preview?.groupMemberAction === "decline_invitation"
                ? "Decline invitation / Từ chối lời mời"
                : "Confirm cancellation / Xác nhận hủy"}
          </button>
          <button
            onClick={() => window.history.back()}
            className="w-full rounded-xl border border-nq-border/40 py-3 text-sm text-nq-muted transition hover:text-nq-text"
          >
            Keep my appointment
          </button>
        </div>}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-nq-bg px-4">
      <div className="w-full max-w-sm rounded-2xl border border-nq-border/40 bg-nq-surface p-8">
        {children}
        <p className="mt-8 text-center text-xs text-nq-muted/50">
          Powered by <a href="https://nailiq.ca" className="underline">NailIQ</a>
        </p>
      </div>
    </div>
  );
}
