"use client";

import Link from "next/link";
import { Check, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import type { GoLiveReadiness } from "@/shared/dashboard/goLiveReadiness";
import { deriveGuidedSetupProgress } from "@/shared/dashboard/guidedSetup";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { skipGuidedSetupIntegrations } from "@/shared/dashboard/skipGuidedSetupIntegrationsAction";

export function GuidedSetupHub({
  slug,
  salonName,
  readiness,
}: {
  slug: string;
  salonName: string;
  readiness: GoLiveReadiness;
}) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const progress = deriveGuidedSetupProgress(slug, readiness);
  const next = progress.nextStep;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm font-semibold text-nq-primary">
          {vi ? "Thiết lập NailIQ" : "Set up NailIQ"}
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-nq-foreground">
          {progress.complete
            ? vi
              ? `${salonName} đã sẵn sàng`
              : `${salonName} is ready`
            : vi
              ? `Hãy hoàn tất ${salonName}`
              : `Let’s finish ${salonName}`}
        </h1>
        <p className="mt-2 text-base leading-6 text-nq-muted">
          {progress.complete
            ? vi
              ? "Mọi bước bắt buộc đã được kiểm tra và phê duyệt."
              : "Every required step has been checked and approved."
            : vi
              ? "NailIQ sẽ chỉ hiển thị một việc cần làm tiếp theo. Bạn có thể rời đi và quay lại bất cứ lúc nào."
              : "NailIQ shows one next action at a time. You can leave and continue later."}
        </p>
      </header>

      <Card variant="elevated" padding="lg">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-semibold text-nq-foreground">
            {vi ? "Tiến độ thiết lập" : "Setup progress"}
          </p>
          <p className="text-sm tabular-nums text-nq-muted" aria-live="polite">
            {progress.percent}%
          </p>
        </div>
        <div
          className="mt-3 h-2 overflow-hidden rounded-full bg-nq-bg"
          role="progressbar"
          aria-label={vi ? "Tiến độ thiết lập" : "Setup progress"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent}
        >
          <div
            className="h-full rounded-full bg-nq-primary"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
        <p className="mt-3 text-sm text-nq-muted">
          {vi
            ? `${progress.completedCount}/${progress.requiredCount} bước bắt buộc đã đạt theo dữ liệu đã lưu`
            : `${progress.completedCount}/${progress.requiredCount} required steps pass from saved data`}
        </p>
      </Card>

      {next ? (
        <Card variant="bordered" padding="lg" className="border-nq-primary/55">
          <p className="text-sm font-semibold text-nq-primary">
            {vi
              ? `Bước ${progress.currentStepNumber} / ${progress.totalStepCount}`
              : `Step ${progress.currentStepNumber} of ${progress.totalStepCount}`}
          </p>
          <h2
            className="mt-2 text-xl font-semibold text-nq-foreground"
            data-testid="guided-setup-next-title"
          >
            {vi ? next.titleVi : next.titleEn}
          </h2>
          <p className="mt-2 text-base leading-6 text-nq-muted">
            {vi ? next.detailVi : next.detailEn}
          </p>
          <div className="mt-4 space-y-3 rounded-2xl border border-nq-border/50 bg-nq-surface/40 p-4 text-sm leading-6">
            <div>
              <p className="font-semibold text-nq-foreground">
                {vi ? "Vì sao cần bước này" : "Why this matters"}
              </p>
              <p className="mt-1 text-nq-muted">
                {vi ? next.reasonVi : next.reasonEn}
              </p>
            </div>
            <div>
              <p className="font-semibold text-nq-foreground">
                {vi ? "NailIQ kiểm tra gì" : "What NailIQ validates"}
              </p>
              <p className="mt-1 text-nq-muted">
                {vi ? next.validationVi : next.validationEn}
              </p>
            </div>
          </div>
          <div className="mt-5 grid gap-3">
            <Link
              href={next.href}
              className="inline-flex min-h-11 w-full touch-manipulation items-center justify-center gap-2 rounded-full bg-nq-primary px-4 text-base font-semibold text-nq-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
              data-testid="guided-setup-next"
            >
              {next.id === "integrations"
                ? vi
                  ? "Xem tích hợp"
                  : "Review integrations"
                : vi
                  ? "Tiếp tục thiết lập"
                  : "Continue setup"}
              <ChevronRight className="h-5 w-5" aria-hidden />
            </Link>
            {next.id === "integrations" ? (
              <form action={skipGuidedSetupIntegrations.bind(null, slug)}>
                <button
                  type="submit"
                  className="inline-flex min-h-11 w-full touch-manipulation items-center justify-center rounded-full border border-nq-border px-4 text-base font-semibold text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
                  data-testid="guided-setup-skip-integrations"
                >
                  {vi ? "Bỏ qua lúc này" : "Skip for now"}
                </button>
              </form>
            ) : null}
          </div>
          <p className="mt-3 text-center text-xs leading-5 text-nq-muted">
            {vi
              ? "Tiến độ được tính lại từ dữ liệu salon đã lưu mỗi khi bạn quay lại — không dựa vào việc đã bấm nút."
              : "Progress is recalculated from saved salon data whenever you return — never from button clicks."}
          </p>
        </Card>
      ) : (
        <Card variant="bordered" padding="lg" className="border-nq-success/40">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-nq-success/15 text-nq-success">
              <Check className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-nq-foreground">
                {vi ? "Thiết lập hoàn tất" : "Setup complete"}
              </h2>
              <p className="mt-1 text-sm text-nq-muted">
                {vi
                  ? "Bạn có thể bắt đầu sử dụng NailIQ."
                  : "You can start using NailIQ."}
              </p>
            </div>
          </div>
          <Link
            href={`/dashboard/${encodeURIComponent(slug)}`}
            className="mt-5 inline-flex min-h-11 w-full touch-manipulation items-center justify-center rounded-full bg-nq-primary px-4 text-base font-semibold text-nq-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
          >
            {vi ? "Mở Dashboard" : "Open Dashboard"}
          </Link>
        </Card>
      )}

      <section aria-labelledby="guided-setup-steps-title">
        <h2
          id="guided-setup-steps-title"
          className="text-base font-semibold text-nq-foreground"
        >
          {vi ? "Các bước của bạn" : "Your steps"}
        </h2>
        <ol className="mt-3 flex flex-col gap-2">
          {progress.steps.map((step, index) => {
            const isCurrent = progress.nextStep?.id === step.id;
            const content = (
              <>
                <span
                  className={
                    step.done
                      ? "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-nq-success/15 text-nq-success"
                      : "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-nq-border text-sm text-nq-muted"
                  }
                >
                  {step.done ? (
                    <Check className="h-4 w-4" aria-hidden />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium text-nq-foreground">
                  <span>{vi ? step.titleVi : step.titleEn}</span>
                  {!step.required ? (
                    <span className="mt-0.5 block text-xs font-normal text-nq-muted">
                      {step.selected
                        ? vi
                          ? "Đã chọn — cần xác minh tích hợp"
                          : "Selected — integration verification required"
                        : step.skipped
                          ? vi
                            ? "Đã bỏ qua — có thể thiết lập sau"
                            : "Skipped — can be configured later"
                          : vi
                            ? "Chưa quyết định — có thể bỏ qua"
                            : "Not decided — may be skipped"}
                    </span>
                  ) : null}
                  {!isCurrent && step.required && !step.done ? (
                    <span className="mt-0.5 block text-xs font-normal text-nq-muted">
                      {vi
                        ? "Hoàn tất bước bắt buộc hiện tại trước"
                        : "Finish the current required step first"}
                    </span>
                  ) : null}
                </span>
              </>
            );

            return (
              <li key={step.id}>
                <Card
                  variant="bordered"
                  padding="sm"
                  aria-disabled="true"
                  aria-current={isCurrent ? "step" : undefined}
                  data-testid={`guided-setup-step-${step.id}`}
                  data-guided-setup-locked="true"
                  className="flex min-h-11 items-center gap-3 opacity-70"
                >
                  {content}
                </Card>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
