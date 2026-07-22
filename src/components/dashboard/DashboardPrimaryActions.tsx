"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarPlus, ChevronRight, UserPlus, Users } from "lucide-react";

export function DashboardPrimaryActions({
  slug,
  language,
}: {
  slug: string;
  language: "en" | "vi";
}) {
  const router = useRouter();
  const L = (en: string, vi: string) => (language === "vi" ? vi : en);
  const dashboardBase = `/dashboard/${encodeURIComponent(slug)}`;

  const openQueue = () => {
    try {
      window.localStorage.setItem("nailiq-queue-panel-open", "1");
    } catch {
      // The queue still opens if storage is unavailable.
    }
    router.push(`${dashboardBase}/center#queue`);
  };

  const actionClass =
    "group flex min-h-[4.5rem] touch-manipulation items-center gap-3 rounded-2xl px-4 py-3 text-left transition duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45";

  return (
    <section aria-label={L("Quick actions", "Thao tác nhanh")}>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-nq-muted/80">
        {L("What would you like to do?", "Bạn muốn làm gì?")}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Link
          href={`${dashboardBase}/center?view=day`}
          className={`${actionClass} bg-nq-primary text-white shadow-[0_8px_24px_rgba(127,92,255,0.24)]`}
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[0.9rem] bg-white/18">
            <CalendarPlus className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-bold">
              {L("New booking", "Tạo lịch hẹn")}
            </span>
            <span className="block text-xs text-white/75">
              {L("Choose time and staff", "Chọn giờ và nhân viên")}
            </span>
          </span>
          <ChevronRight className="h-5 w-5 text-white/70" aria-hidden />
        </Link>

        <button
          type="button"
          onClick={openQueue}
          className={`${actionClass} border border-nq-border/45 bg-nq-surface/55`}
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[0.9rem] bg-nq-primary/12 text-nq-primary">
            <Users className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-bold text-nq-foreground">
              {L("Walk-in customer", "Khách vãng lai")}
            </span>
            <span className="block text-xs text-nq-muted">
              {L("Add to the waiting list", "Thêm vào danh sách chờ")}
            </span>
          </span>
          <ChevronRight className="h-5 w-5 text-nq-muted/60" aria-hidden />
        </button>

        <Link
          href={`${dashboardBase}/clients`}
          className={`${actionClass} border border-nq-border/45 bg-nq-surface/55`}
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[0.9rem] bg-nq-primary/12 text-nq-primary">
            <UserPlus className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-bold text-nq-foreground">
              {L("Add customer", "Thêm khách hàng")}
            </span>
            <span className="block text-xs text-nq-muted">
              {L("Save their information", "Lưu thông tin khách")}
            </span>
          </span>
          <ChevronRight className="h-5 w-5 text-nq-muted/60" aria-hidden />
        </Link>
      </div>
    </section>
  );
}
