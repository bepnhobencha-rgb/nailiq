import Link from "next/link";

import { Card } from "@/components/ui/Card";

export function TrialSetupProgressBanner({
  slug,
  language,
  daysLeft,
  completedCount,
  requiredCount,
  percent,
}: {
  slug: string;
  language: string;
  daysLeft: number;
  completedCount: number;
  requiredCount: number;
  percent: number;
}) {
  const vi = language === "vi";
  const setupComplete = requiredCount > 0 && completedCount >= requiredCount;
  const href = setupComplete
    ? `/dashboard/${encodeURIComponent(slug)}/settings#cat-plan`
    : `/dashboard/${encodeURIComponent(slug)}/setup`;

  return (
    <Card
      variant="bordered"
      padding="sm"
      className="mx-4 mt-3 border-nq-primary/35 sm:ml-6 sm:mr-36 sm:mt-4"
      role="status"
      data-testid="trial-setup-progress"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3 text-sm">
            <p className="truncate font-semibold text-nq-foreground">
              {daysLeft === 0
                ? vi
                  ? "Dùng thử đã kết thúc"
                  : "Trial ended"
                : vi
                  ? `Còn ${daysLeft} ngày · Thiết lập ${completedCount}/${requiredCount}`
                  : `${daysLeft} days left · Setup ${completedCount}/${requiredCount}`}
            </p>
            <span className="shrink-0 tabular-nums text-nq-muted">{percent}%</span>
          </div>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-nq-bg"
            role="progressbar"
            aria-label={vi ? "Tiến độ thiết lập salon" : "Salon setup progress"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="h-full rounded-full bg-nq-primary" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <Link
          href={href}
          className="inline-flex min-h-11 shrink-0 touch-manipulation items-center rounded-full px-3 text-sm font-semibold text-nq-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
        >
          {setupComplete
            ? vi
              ? "Xem gói"
              : "View plans"
            : vi
              ? "Tiếp tục"
              : "Continue"}
        </Link>
      </div>
    </Card>
  );
}
