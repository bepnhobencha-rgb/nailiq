"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import {
  type GoLiveAttestationEvent,
  type GoLiveAttestationKey,
  type GoLiveAttestationState,
  isGuidedPilotAttestationBlocked,
} from "@/shared/dashboard/goLiveAttestations";
import { recordGoLiveAttestation } from "@/shared/dashboard/goLiveAttestationAction";
import type { GoLiveReadiness } from "@/shared/dashboard/goLiveReadiness";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type ConfirmationDefinition = {
  key: GoLiveAttestationKey;
  titleEn: string;
  titleVi: string;
  promptEn: string;
  promptVi: string;
};

const confirmations: ConfirmationDefinition[] = [
  {
    key: "hours_confirmed",
    titleEn: "Real business hours confirmed",
    titleVi: "Đã xác nhận giờ làm việc thực tế",
    promptEn: "Note who confirmed the hours and how they were checked.",
    promptVi: "Ghi người đã xác nhận giờ và cách kiểm tra.",
  },
  {
    key: "otp_policy_confirmed",
    titleEn: "OTP, A2P, and consent policy confirmed",
    titleVi: "Đã xác nhận OTP, A2P và chính sách đồng ý",
    promptEn: "Record the owner decision and delivery/wording evidence.",
    promptVi: "Ghi quyết định của chủ tiệm và bằng chứng gửi/nội dung.",
  },
  {
    key: "live_rehearsal_completed",
    titleEn: "Owner-approved live rehearsal completed",
    titleVi: "Đã hoàn tất chạy thử được chủ tiệm cho phép",
    promptEn: "Record the test booking, roles checked, result, and cleanup.",
    promptVi: "Ghi lịch thử, quyền đã kiểm tra, kết quả và việc dọn dữ liệu.",
  },
  {
    key: "owner_approved",
    titleEn: "Final owner approval",
    titleVi: "Chủ tiệm phê duyệt cuối",
    promptEn: "Record the owner's explicit go-live decision.",
    promptVi: "Ghi quyết định go-live rõ ràng của chủ tiệm.",
  },
];

function isActive(
  key: GoLiveAttestationKey,
  state: GoLiveAttestationState,
) {
  if (key === "hours_confirmed") return state.hoursConfirmed;
  if (key === "otp_policy_confirmed") return state.otpPolicyConfirmed;
  if (key === "live_rehearsal_completed")
    return state.liveRehearsalCompleted;
  return state.ownerApproved;
}

function eventLabel(key: GoLiveAttestationKey, vi: boolean): string {
  const item = confirmations.find((confirmation) => confirmation.key === key);
  return vi ? (item?.titleVi ?? key) : (item?.titleEn ?? key);
}

function utcLabel(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function GoLiveAttestationControls({
  slug,
  role,
  readiness,
  state,
  events,
  guidedSetupEnabled,
}: {
  slug: string;
  role: "owner" | "admin";
  readiness: GoLiveReadiness;
  state: GoLiveAttestationState;
  events: GoLiveAttestationEvent[];
  guidedSetupEnabled: boolean;
}) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [pendingKey, setPendingKey] = useState<GoLiveAttestationKey | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const technicalReady = readiness.readyForManualReview;
  const prerequisitesReady =
    state.hoursConfirmed &&
    state.otpPolicyConfirmed &&
    state.liveRehearsalCompleted;

  function canAttest(key: GoLiveAttestationKey): boolean {
    if (key === "owner_approved")
      return role === "owner" && technicalReady && prerequisitesReady;
    if (key === "live_rehearsal_completed") return technicalReady;
    if (key === "hours_confirmed") {
      return (
        readiness.checks.find((check) => check.id === "schedule")?.state ===
        "pass"
      );
    }
    return true;
  }

  function submit(key: GoLiveAttestationKey, active: boolean) {
    const evidenceNote = notes[key]?.trim() ?? "";
    if (evidenceNote.length < 10) {
      setMessage(
        vi
          ? "Ghi chú bằng chứng cần ít nhất 10 ký tự."
          : "Evidence note must be at least 10 characters.",
      );
      return;
    }
    setMessage(null);
    setPendingKey(key);
    startTransition(async () => {
      const result = await recordGoLiveAttestation(slug, {
        checkKey: key,
        action: active ? "revoke" : "attest",
        evidenceNote,
      });
      setPendingKey(null);
      if (!result.ok) {
        const copy = {
          unauthorized: vi
            ? "Bạn không có quyền thực hiện."
            : "You do not have permission.",
          invalid_input: vi
            ? "Ghi chú hoặc dữ liệu không hợp lệ."
            : "The note or request is invalid.",
          technical_gates_incomplete: vi
            ? "Cần hoàn tất các cổng kỹ thuật liên quan trước."
            : "Complete the related technical gates first.",
          prerequisites_incomplete: vi
            ? "Cần hoàn tất ba xác nhận con người trước."
            : "Complete all three human confirmations first.",
          guided_preview_unavailable: vi
            ? "Prototype QA chưa có preview an toàn nên không thể ghi nhận bước này."
            : "The QA prototype has no safe preview, so this confirmation cannot be recorded.",
          unavailable: vi
            ? "Không thể lưu xác nhận. Chưa có thay đổi nào được ghi nhận."
            : "Could not save the confirmation. Nothing was recorded.",
        } as const;
        setMessage(copy[result.reason]);
        return;
      }
      setNotes((current) => ({ ...current, [key]: "" }));
      setMessage(
        vi
          ? result.unchanged
            ? "Trạng thái này đã được ghi nhận trước đó."
            : "Đã ghi vào lịch sử audit."
          : result.unchanged
            ? "This state was already recorded."
            : "Recorded in the audit history.",
      );
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="go-live-attestation-title">
      <h2
        id="go-live-attestation-title"
        className="text-lg font-semibold text-nq-foreground"
      >
        {vi ? "Hồ sơ xác nhận" : "Confirmation record"}
      </h2>
      <p className="mt-1 text-sm leading-6 text-nq-muted">
        {vi
          ? "Mỗi thao tác tạo một sự kiện audit mới. Không thể sửa hoặc xóa lịch sử."
          : "Every action appends a new audit event. History cannot be edited or deleted."}
      </p>

      {message ? (
        <p
          role="status"
          data-testid="go-live-attestation-message"
          className="mt-3 rounded-xl border border-nq-border/50 bg-nq-surface/50 px-3 py-2 text-sm text-nq-foreground"
        >
          {message}
        </p>
      ) : null}

      <div className="mt-3 space-y-3">
        {guidedSetupEnabled ? (
          <p
            role="status"
            data-testid="guided-preview-attestation-blocked"
            className="rounded-2xl border border-nq-primary/40 bg-nq-primary/5 p-4 text-sm leading-6 text-nq-foreground"
          >
            {vi
              ? "Chạy thử và phê duyệt cuối đang bị khóa cho prototype QA đến khi có preview được xác thực và không tạo side effect."
              : "Rehearsal and final approval are locked for the QA prototype until an authenticated, side-effect-free preview exists."}
          </p>
        ) : null}
        {confirmations
          .filter(
            (confirmation) =>
              !isGuidedPilotAttestationBlocked(
                guidedSetupEnabled,
                confirmation.key,
              ),
          )
          .map((confirmation) => {
          const active = isActive(confirmation.key, state);
          const ownerOnly =
            confirmation.key === "owner_approved" && role !== "owner";
          const allowed = canAttest(confirmation.key);
          const staleOwnerApproval =
            confirmation.key === "owner_approved" &&
            state.ownerApprovalStale &&
            !state.ownerApproved;
          return (
            <article
              key={confirmation.key}
              data-testid={`go-live-attestation-${confirmation.key}`}
              className="rounded-2xl border border-nq-border/40 bg-nq-surface/45 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-nq-foreground">
                  {vi ? confirmation.titleVi : confirmation.titleEn}
                </h3>
                <span
                  className={
                    active
                      ? "rounded-full bg-nq-success/10 px-2 py-1 text-xs font-semibold text-nq-success"
                      : "rounded-full bg-nq-primary/10 px-2 py-1 text-xs font-semibold text-nq-primary"
                  }
                >
                  {active
                    ? vi
                      ? "Đang hiệu lực"
                      : "Active"
                    : staleOwnerApproval
                      ? vi
                        ? "Cần phê duyệt lại"
                        : "Reapproval required"
                      : vi
                        ? "Chưa xác nhận"
                        : "Not confirmed"}
                </span>
              </div>
              <p className="mt-1 text-sm leading-6 text-nq-muted">
                {vi ? confirmation.promptVi : confirmation.promptEn}
              </p>

              {ownerOnly ? (
                <p className="mt-3 text-sm text-nq-muted">
                  {vi
                    ? "Chỉ tài khoản Owner được phê duyệt cuối."
                    : "Only an Owner account can give final approval."}
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  <label className="block text-sm font-medium text-nq-foreground">
                    {vi ? "Ghi chú bằng chứng" : "Evidence note"}
                    <textarea
                      value={notes[confirmation.key] ?? ""}
                      onChange={(event) =>
                        setNotes((current) => ({
                          ...current,
                          [confirmation.key]: event.target.value,
                        }))
                      }
                      maxLength={500}
                      rows={3}
                      data-testid={`go-live-note-${confirmation.key}`}
                      placeholder={
                        vi
                          ? "Ai xác nhận, kiểm tra gì, kết quả..."
                          : "Who confirmed, what was checked, result..."
                      }
                      className="mt-1 block w-full rounded-xl border border-nq-border/60 bg-nq-bg/70 px-3 py-2 text-base text-nq-foreground outline-none placeholder:text-nq-muted focus:border-nq-primary"
                    />
                  </label>
                  <Button
                    type="button"
                    size="md"
                    variant={active ? "danger" : "primary"}
                    loading={isPending && pendingKey === confirmation.key}
                    disabled={!active && !allowed}
                    onClick={() => submit(confirmation.key, active)}
                    data-testid={`go-live-submit-${confirmation.key}`}
                  >
                    {active
                      ? vi
                        ? "Thu hồi xác nhận"
                        : "Revoke confirmation"
                      : staleOwnerApproval
                        ? vi
                          ? "Phê duyệt lại"
                          : "Approve again"
                        : vi
                          ? "Ghi nhận xác nhận"
                          : "Record confirmation"}
                  </Button>
                  {!active && !allowed ? (
                    <p className="text-xs leading-5 text-nq-muted">
                      {vi
                        ? "Hoàn tất các điều kiện phía trên trước khi ghi nhận bước này."
                        : "Complete the conditions above before recording this step."}
                    </p>
                  ) : null}
                </div>
              )}
            </article>
          );
          })}
      </div>

      <div className="mt-6">
        <h3 className="font-semibold text-nq-foreground">
          {vi ? "Lịch sử gần đây" : "Recent history"}
        </h3>
        {events.length === 0 ? (
          <p className="mt-2 text-sm text-nq-muted">
            {vi ? "Chưa có sự kiện xác nhận." : "No confirmation events yet."}
          </p>
        ) : (
          <ol
            data-testid="go-live-attestation-history"
            className="mt-2 divide-y divide-nq-border/30 rounded-2xl border border-nq-border/40 bg-nq-surface/35 px-4"
          >
            {events.slice(0, 10).map((event) => (
              <li key={event.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-nq-foreground">
                    {event.action === "attest"
                      ? vi
                        ? "Xác nhận"
                        : "Confirmed"
                      : vi
                        ? "Thu hồi"
                        : "Revoked"}{" "}
                    · {eventLabel(event.checkKey, vi)}
                  </span>
                  <time className="text-xs text-nq-muted">
                    {utcLabel(event.createdAt)}
                  </time>
                </div>
                <p className="mt-1 text-nq-muted">{event.evidenceNote}</p>
                <p className="mt-1 text-xs uppercase tracking-wide text-nq-muted">
                  {event.actorRole}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
