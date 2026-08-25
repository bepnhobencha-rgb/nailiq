"use client";

import Link from "next/link";
import {
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  Settings,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function GuidedAdminActionCenter({
  slug,
  salonName,
}: {
  slug: string;
  salonName: string;
}) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const dashboardBase = `/dashboard/${encodeURIComponent(slug)}`;

  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-8 sm:px-6"
      data-testid="guided-admin-action-center"
    >
      <header>
        <span className="inline-flex items-center gap-2 rounded-full bg-nq-success/15 px-3 py-1 text-sm font-semibold text-nq-success">
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          {vi ? "Sẵn sàng hoạt động" : "Ready to operate"}
        </span>
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-nq-foreground sm:text-3xl">
          {vi
            ? `Bắt đầu ngày làm việc tại ${salonName}`
            : `Start the day at ${salonName}`}
        </h1>
        <p className="mt-2 text-base leading-6 text-nq-muted">
          {vi
            ? "Thiết lập bắt buộc đã hoàn tất. NailIQ chỉ đưa việc quan trọng nhất lên trước."
            : "Required setup is complete. NailIQ puts the most important action first."}
        </p>
      </header>

      <Card variant="elevated" padding="lg" className="border-nq-primary/45">
        <p className="text-sm font-semibold uppercase tracking-wide text-nq-primary">
          {vi ? "Việc tiếp theo" : "Next action"}
        </p>
        <h2 className="mt-2 text-xl font-semibold text-nq-foreground">
          {vi ? "Mở bàn Tiếp tân" : "Open Front Desk"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-nq-muted">
          {vi
            ? "Xem lịch hôm nay, khách đang chờ và những việc cần xử lý."
            : "See today's schedule, waiting guests, and items that need attention."}
        </p>
        <Link
          href={`${dashboardBase}/center`}
          className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-nq-primary px-5 text-base font-semibold text-nq-bg"
          data-testid="guided-action-open-front-desk"
        >
          <CalendarDays className="h-5 w-5" aria-hidden />
          {vi ? "Mở Tiếp tân" : "Open Front Desk"}
        </Link>
      </Card>

      <section aria-labelledby="guided-admin-common-tasks">
        <h2
          id="guided-admin-common-tasks"
          className="text-base font-semibold text-nq-foreground"
        >
          {vi ? "Khi cần" : "When needed"}
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Card
            as={Link}
            href={`/${encodeURIComponent(slug)}`}
            state="interactive"
            variant="bordered"
          >
            <ExternalLink className="h-5 w-5 text-nq-primary" aria-hidden />
            <p className="mt-3 font-semibold text-nq-foreground">
              {vi ? "Xem trang đặt lịch" : "Preview booking page"}
            </p>
          </Card>
          <Card
            as={Link}
            href={`${dashboardBase}/settings`}
            state="interactive"
            variant="bordered"
          >
            <Settings className="h-5 w-5 text-nq-primary" aria-hidden />
            <p className="mt-3 font-semibold text-nq-foreground">
              {vi ? "Điều chỉnh cài đặt" : "Adjust settings"}
            </p>
          </Card>
        </div>
      </section>
    </div>
  );
}
