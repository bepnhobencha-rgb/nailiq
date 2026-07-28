"use client";

import Link from "next/link";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import type {
  GoLiveReadiness,
  GoLiveReadinessCheck,
} from "@/shared/dashboard/goLiveReadiness";
import { cn } from "@/shared/lib/cn";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { GoLiveAttestationControls } from "@/components/dashboard/GoLiveAttestationControls";
import type {
  GoLiveAttestationEvent,
  GoLiveAttestationState,
} from "@/shared/dashboard/goLiveAttestations";

function CheckCard({
  check,
  vi,
}: {
  check: GoLiveReadinessCheck;
  vi: boolean;
}) {
  const isPass = check.state === "pass";
  const isAction = check.state === "action";
  const content = (
    <>
      <span
        aria-hidden
        className={cn(
          "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-sm font-semibold",
          isPass
            ? "border-nq-success/50 bg-nq-success/10 text-nq-success"
            : isAction
              ? "border-nq-danger/50 bg-nq-danger/10 text-nq-danger"
              : "border-nq-primary/50 bg-nq-primary/10 text-nq-primary",
        )}
      >
        {isPass ? "✓" : isAction ? "!" : "?"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-nq-foreground">
            {vi ? check.titleVi : check.titleEn}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
              isPass
                ? "bg-nq-success/10 text-nq-success"
                : isAction
                  ? "bg-nq-danger/10 text-nq-danger"
                  : "bg-nq-primary/10 text-nq-primary",
            )}
          >
            {isPass
              ? vi
                ? "Đạt"
                : "Pass"
              : isAction
                ? vi
                  ? "Cần sửa"
                  : "Action"
                : vi
                  ? "Cần xác nhận"
                  : "Review"}
          </span>
        </span>
        <span className="mt-1 block text-sm leading-6 text-nq-muted">
          {vi ? check.detailVi : check.detailEn}
        </span>
      </span>
      {check.href ? (
        <span aria-hidden className="shrink-0 text-nq-primary">
          →
        </span>
      ) : null}
    </>
  );

  const className =
    "flex min-h-16 items-start gap-3 rounded-2xl border border-nq-border/40 bg-nq-surface/45 p-4";

  return check.href ? (
    <Link
      href={check.href}
      data-testid={`readiness-check-${check.id}`}
      className={cn(
        className,
        "transition-colors hover:border-nq-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40",
      )}
    >
      {content}
    </Link>
  ) : (
    <div data-testid={`readiness-check-${check.id}`} className={className}>
      {content}
    </div>
  );
}

export function GoLiveReadinessPanel({
  readiness,
  salonName,
  slug,
  role,
  attestationState,
  attestationEvents,
}: {
  readiness: GoLiveReadiness;
  salonName: string;
  slug: string;
  role: "owner" | "admin";
  attestationState: GoLiveAttestationState;
  attestationEvents: GoLiveAttestationEvent[];
}) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const automated = readiness.checks.filter(
    (check) =>
      check.id !== "hours-confirmation" &&
      check.id !== "otp-policy" &&
      check.id !== "human-approval" &&
      check.id !== "owner-approval",
  );
  const human = readiness.checks.filter(
    (check) =>
      check.id === "hours-confirmation" ||
      check.id === "otp-policy" ||
      check.id === "human-approval" ||
      check.id === "owner-approval",
  );

  return (
    <div className="space-y-6">
      <section
        data-testid="go-live-readiness-summary"
        className={cn(
          "rounded-3xl border p-5 sm:p-6",
          readiness.approvedForGoLive
            ? "border-nq-success/35 bg-nq-success/5"
            : "border-nq-primary/30 bg-nq-surface/50",
        )}
      >
        <p className="text-sm font-medium text-nq-muted">{salonName}</p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-3xl font-semibold text-nq-foreground">
              {readiness.passedBlocking}/{readiness.totalBlocking}
            </p>
            <p className="mt-1 text-sm text-nq-muted">
              {vi
                ? "điều kiện kỹ thuật bắt buộc đã đạt"
                : "required technical gates passed"}
            </p>
          </div>
          <span
            className={cn(
              "rounded-full px-3 py-1.5 text-sm font-semibold",
              readiness.approvedForGoLive
                ? "bg-nq-success/10 text-nq-success"
                : "bg-nq-primary/10 text-nq-primary",
            )}
          >
            {readiness.approvedForGoLive
              ? vi
                ? "Đã được phê duyệt go-live"
                : "Approved for go-live"
              : readiness.readyForManualReview
                ? vi
                  ? "Sẵn sàng kiểm tra thủ công"
                  : "Ready for manual review"
              : vi
                ? "Chưa sẵn sàng go-live"
                : "Not ready for go-live"}
          </span>
        </div>
        <p className="mt-4 text-sm leading-6 text-nq-muted">
          {vi
            ? "Trạng thái này chỉ xác nhận dữ liệu kỹ thuật. NailIQ không tự phê duyệt go-live và không tạo booking, gửi tin nhắn hay thu tiền từ màn hình này."
            : "This status covers technical data only. NailIQ does not approve go-live or create bookings, send messages, or charge money from this screen."}
        </p>
      </section>

      <section aria-labelledby="automated-readiness-title">
        <h2
          id="automated-readiness-title"
          className="text-lg font-semibold text-nq-foreground"
        >
          {vi ? "Kiểm tra tự động" : "Automated checks"}
        </h2>
        <p className="mt-1 text-sm text-nq-muted">
          {vi
            ? "Đọc trực tiếp cấu hình hiện tại của tiệm."
            : "Read directly from the salon's current configuration."}
        </p>
        <div className="mt-3 space-y-3">
          {automated.map((check) => (
            <CheckCard key={check.id} check={check} vi={vi} />
          ))}
        </div>
      </section>

      <section aria-labelledby="human-readiness-title">
        <h2
          id="human-readiness-title"
          className="text-lg font-semibold text-nq-foreground"
        >
          {vi ? "Bắt buộc có người xác nhận" : "Human confirmation required"}
        </h2>
        <p className="mt-1 text-sm text-nq-muted">
          {vi
            ? "Không được đánh dấu tự động hoặc thay thế bằng test giả lập."
            : "These cannot be auto-approved or replaced by simulated tests."}
        </p>
        <div className="mt-3 space-y-3">
          {human.map((check) => (
            <CheckCard key={check.id} check={check} vi={vi} />
          ))}
        </div>
      </section>

      <GoLiveAttestationControls
        slug={slug}
        role={role}
        readiness={readiness}
        state={attestationState}
        events={attestationEvents}
      />
    </div>
  );
}

export function GoLiveReadinessPageContent({
  slug,
  readiness,
  salonName,
  role,
  attestationState,
  attestationEvents,
}: {
  slug: string;
  readiness: GoLiveReadiness | null;
  salonName: string | null;
  role: "owner" | "admin" | null;
  attestationState: GoLiveAttestationState | null;
  attestationEvents: GoLiveAttestationEvent[];
}) {
  const { language } = useUserLanguage();
  const vi = language === "vi";

  return (
    <>
      <SetupBackNav
        slug={slug}
        title={vi ? "Sẵn sàng Go-Live" : "Go-Live Readiness"}
      />
      {!readiness || !salonName || !role || !attestationState ? (
        <section
          role="alert"
          data-testid="go-live-readiness-unavailable"
          className="rounded-2xl border border-nq-danger/40 bg-nq-danger/10 p-4 text-sm leading-6 text-nq-foreground"
        >
          {vi
            ? "Không thể đọc dữ liệu sẵn sàng. Hệ thống chưa đưa ra quyết định go-live. Vui lòng thử lại."
            : "Readiness data is unavailable. No go-live decision was made. Please try again."}
        </section>
      ) : (
        <GoLiveReadinessPanel
          readiness={readiness}
          salonName={salonName}
          slug={slug}
          role={role}
          attestationState={attestationState}
          attestationEvents={attestationEvents}
        />
      )}
    </>
  );
}
