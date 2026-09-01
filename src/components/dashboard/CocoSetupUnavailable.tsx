"use client";

import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

export function CocoSetupUnavailable({
  slug,
  salonName,
}: {
  slug: string;
  salonName: string;
}) {
  const { language } = useUserLanguage();
  const vi = language === "vi";
  const dashboard = `/dashboard/${encodeURIComponent(slug)}`;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm font-semibold text-nq-primary">Coco Setup</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-nq-foreground">
          {vi ? `Thiết lập ${salonName}` : `Set up ${salonName}`}
        </h1>
      </header>

      <Card variant="bordered" padding="lg">
        <h2 className="text-lg font-semibold text-nq-foreground">
          {vi
            ? "Coco đang tạm dừng an toàn"
            : "Coco is safely paused"}
        </h2>
        <p className="mt-2 text-base leading-6 text-nq-muted">
          {vi
            ? "NailIQ chưa thể đọc trạng thái điều khiển Coco. Coco không thay đổi cài đặt hoặc trạng thái nhận booking của salon."
            : "NailIQ cannot verify Coco's control state right now. Coco did not change any settings or the salon's booking availability."}
        </p>
        <div className="mt-5 grid gap-3">
          <Link
            href={`${dashboard}/setup/services`}
            className="inline-flex min-h-11 w-full touch-manipulation items-center justify-center rounded-full bg-nq-primary px-4 text-base font-semibold text-nq-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
          >
            {vi ? "Tiếp tục thiết lập thủ công" : "Continue manual setup"}
          </Link>
          <Link
            href={dashboard}
            className="inline-flex min-h-11 w-full touch-manipulation items-center justify-center rounded-full border border-nq-border px-4 text-base font-semibold text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary"
          >
            {vi ? "Về Dashboard" : "Back to Dashboard"}
          </Link>
        </div>
      </Card>
    </div>
  );
}
