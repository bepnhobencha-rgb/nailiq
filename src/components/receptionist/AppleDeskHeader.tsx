"use client";

import Link from "next/link";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";

type AppleDeskHeaderProps = {
  salonName: string;
  selectedDate: string;
  selectedOffset: -1 | 0 | 1;
  connectionState: "connected" | "reconnecting" | "offline";
  language: "en" | "vi";
  clientHref: string;
  ownerHref: string;
  canAddWalkin: boolean;
  canAddAppointment: boolean;
  canAddGroup: boolean;
  settings: ReactNode;
  onDateChange: (offset: -1 | 0 | 1) => void;
  onAddWalkin: () => void;
  onAddAppointment: () => void;
  onAddGroup: () => void;
};

function dateLabel(ymd: string, language: "en" | "vi"): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  return new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-CA", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

export function AppleDeskHeader({
  salonName,
  selectedDate,
  selectedOffset,
  connectionState,
  language,
  clientHref,
  ownerHref,
  canAddWalkin,
  canAddAppointment,
  canAddGroup,
  settings,
  onDateChange,
  onAddWalkin,
  onAddAppointment,
  onAddGroup,
}: AppleDeskHeaderProps) {
  const connected = connectionState === "connected";
  const salonInitial = salonName.trim().charAt(0).toUpperCase() || "N";
  const hasQuickAction = canAddWalkin || canAddAppointment || canAddGroup;

  return (
    <header
      data-testid="preview-apple-header"
      className="relative z-30 hidden min-h-[72px] shrink-0 grid-cols-[minmax(13rem,1fr)_auto_minmax(13rem,1fr)] items-center rounded-lg border border-[var(--rc-new-border)] bg-[var(--rc-new-surface)] px-5 shadow-sm md:grid"
    >
      <details className="group relative min-w-0 justify-self-start">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-nq-info [&::-webkit-details-marker]:hidden">
          <span className="text-xl font-semibold tracking-[-0.02em] text-[var(--rc-new-text)]">
            {language === "vi" ? "Hôm nay" : "Today"}
          </span>
          <span className="h-7 w-px bg-[var(--rc-new-border)]" aria-hidden />
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--rc-new-muted)]">
            <span className="max-w-44 truncate">{salonName}</span>
            <ChevronDown
              className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
              aria-hidden
            />
          </span>
        </summary>
        <div className="absolute left-0 top-full z-50 mt-3 min-w-72 rounded-2xl border border-[var(--rc-new-border)] bg-[var(--rc-new-surface)] p-3 shadow-xl">
          <div className="flex flex-wrap items-center gap-2">{settings}</div>
        </div>
      </details>

      <nav
        className="flex items-center gap-3"
        aria-label={language === "vi" ? "Chọn ngày" : "Choose day"}
      >
        <button
          type="button"
          onClick={() => onDateChange((selectedOffset - 1) as -1 | 0)}
          disabled={selectedOffset === -1}
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--rc-new-border)] text-[var(--rc-new-text)] transition hover:bg-[var(--rc-new-surface-subtle)] disabled:cursor-not-allowed disabled:opacity-35"
          aria-label={language === "vi" ? "Ngày trước" : "Previous day"}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <div className="flex h-10 min-w-56 items-center justify-center gap-3 rounded-lg border border-[var(--rc-new-border)] bg-[var(--rc-new-surface)] px-4 text-sm font-semibold text-[var(--rc-new-text)] shadow-sm">
          <CalendarDays
            className="h-4 w-4 text-[var(--rc-new-muted)]"
            aria-hidden
          />
          <span className="capitalize">{dateLabel(selectedDate, language)}</span>
        </div>
        <button
          type="button"
          onClick={() => onDateChange((selectedOffset + 1) as 0 | 1)}
          disabled={selectedOffset === 1}
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--rc-new-border)] text-[var(--rc-new-text)] transition hover:bg-[var(--rc-new-surface-subtle)] disabled:cursor-not-allowed disabled:opacity-35"
          aria-label={language === "vi" ? "Ngày sau" : "Next day"}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => onDateChange(0)}
          className={cn(
            "h-10 rounded-lg border px-4 text-xs font-semibold transition",
            selectedOffset === 0
              ? "border-nq-primary/35 bg-nq-primary/10 text-nq-primary"
              : "border-[var(--rc-new-border)] text-[var(--rc-new-text)] hover:bg-[var(--rc-new-surface-subtle)]",
          )}
        >
          {language === "vi" ? "Hôm nay" : "Today"}
        </button>
      </nav>

      <div className="flex items-center justify-self-end gap-3 pr-32">
        <span
          className="hidden items-center gap-2 text-xs text-[var(--rc-new-muted)] 2xl:inline-flex"
          role="status"
        >
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              connected
                ? "bg-nq-success"
                : connectionState === "reconnecting"
                  ? "bg-nq-warning"
                  : "bg-nq-error",
            )}
            aria-hidden
          />
          {connected
            ? language === "vi"
              ? "Đã đồng bộ"
              : "Synced"
            : connectionState === "reconnecting"
              ? language === "vi"
                ? "Đang kết nối"
                : "Reconnecting"
              : language === "vi"
                ? "Ngoại tuyến"
                : "Offline"}
        </span>
        <Link
          href={clientHref}
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--rc-new-border)] text-[var(--rc-new-text)] transition hover:bg-[var(--rc-new-surface-subtle)]"
          aria-label={language === "vi" ? "Tìm khách hàng" : "Search customers"}
        >
          <Search className="h-4 w-4" aria-hidden />
        </Link>
        {hasQuickAction ? (
          <details className="group relative">
            <summary className="inline-flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-full bg-[var(--rc-new-control)] text-white shadow-sm transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-info [&::-webkit-details-marker]:hidden">
              <Plus className="h-5 w-5 transition-transform group-open:rotate-45" />
              <span className="sr-only">
                {language === "vi" ? "Tạo mới" : "Create new"}
              </span>
            </summary>
            <div className="absolute right-0 top-full z-50 mt-3 w-48 rounded-2xl border border-[var(--rc-new-border)] bg-[var(--rc-new-surface)] p-2 shadow-xl">
              {canAddAppointment ? (
                <button
                  type="button"
                  onClick={onAddAppointment}
                  className="flex min-h-11 w-full items-center rounded-xl px-3 text-left text-sm font-medium text-[var(--rc-new-text)] hover:bg-[var(--rc-new-surface-subtle)]"
                >
                  {language === "vi" ? "Lịch hẹn mới" : "New appointment"}
                </button>
              ) : null}
              {canAddWalkin ? (
                <button
                  type="button"
                  onClick={onAddWalkin}
                  className="flex min-h-11 w-full items-center rounded-xl px-3 text-left text-sm font-medium text-[var(--rc-new-text)] hover:bg-[var(--rc-new-surface-subtle)]"
                >
                  {language === "vi" ? "Thêm khách vãng lai" : "Add walk-in"}
                </button>
              ) : null}
              {canAddGroup ? (
                <button
                  type="button"
                  onClick={onAddGroup}
                  className="flex min-h-11 w-full items-center rounded-xl px-3 text-left text-sm font-medium text-[var(--rc-new-text)] hover:bg-[var(--rc-new-surface-subtle)]"
                >
                  {language === "vi" ? "Đặt lịch nhóm" : "Group booking"}
                </button>
              ) : null}
            </div>
          </details>
        ) : null}
        <Link
          href={ownerHref}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-[var(--rc-new-border)] bg-[var(--rc-new-surface-subtle)] text-sm font-semibold text-[var(--rc-new-text)]"
          aria-label={language === "vi" ? "Trang quản lý" : "Owner dashboard"}
        >
          {salonInitial}
        </Link>
      </div>
    </header>
  );
}
