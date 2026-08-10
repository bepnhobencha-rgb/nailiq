"use client";

import Link from "next/link";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import { LogoutButton } from "@/components/dashboard/LogoutButton";
import {
  searchClients,
  type ClientSearchHit,
} from "@/shared/dashboard/searchClientsAction";
import { formatPhone } from "@/shared/lib/phoneFormat";
import { cn } from "@/shared/lib/cn";
import { localDateToYmd, ymdToLocalDate } from "@/shared/lib/localDateYmd";

type AppleDeskHeaderProps = {
  slug: string;
  salonName: string;
  selectedDate: string;
  selectedOffset: -1 | 0 | 1 | null;
  viewMode: "day" | "week" | "month";
  connectionState: "connected" | "reconnecting" | "offline";
  language: "en" | "vi";
  clientHref: string;
  ownerHref: string;
  settingsHref: string;
  canAddWalkin: boolean;
  canAddAppointment: boolean;
  canAddGroup: boolean;
  settings: ReactNode;
  onDateChange: (offset: -1 | 0 | 1) => void;
  onSelectDate: (ymd: string) => void;
  onViewModeChange: (mode: "day" | "week" | "month") => void;
  onSelectClient: (client: ClientSearchHit) => void;
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

function shiftYmd(ymd: string, days: number): string {
  const date = ymdToLocalDate(ymd);
  date.setDate(date.getDate() + days);
  return localDateToYmd(date);
}

export function AppleDeskHeader({
  slug,
  salonName,
  selectedDate,
  selectedOffset,
  viewMode,
  connectionState,
  language,
  clientHref,
  ownerHref,
  settingsHref,
  canAddWalkin,
  canAddAppointment,
  canAddGroup,
  settings,
  onDateChange,
  onSelectDate,
  onViewModeChange,
  onSelectClient,
  onAddWalkin,
  onAddAppointment,
  onAddGroup,
}: AppleDeskHeaderProps) {
  const connected = connectionState === "connected";
  const salonInitial = salonName.trim().charAt(0).toUpperCase() || "N";
  const hasQuickAction = canAddWalkin || canAddAppointment || canAddGroup;
  const dateMenuRef = useRef<HTMLDetailsElement>(null);
  const accountMenuRef = useRef<HTMLDetailsElement>(null);

  return (
    <header
      data-testid="preview-apple-header"
      className="relative z-30 hidden min-h-[72px] shrink-0 grid-cols-[minmax(13rem,1fr)_auto_minmax(13rem,1fr)] items-center rounded-lg border border-[var(--rc-new-border)] bg-[var(--rc-new-surface)] px-5 shadow-sm md:grid"
    >
      <details className="group relative min-w-0 justify-self-start">
        <summary
          data-testid="preview-settings-trigger"
          className="flex cursor-pointer list-none items-center gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-nq-info [&::-webkit-details-marker]:hidden"
        >
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
          onClick={() => {
            if (selectedOffset === null) {
              onSelectDate(shiftYmd(selectedDate, -1));
              return;
            }
            onDateChange((selectedOffset - 1) as -1 | 0);
          }}
          disabled={selectedOffset === -1}
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--rc-new-border)] text-[var(--rc-new-text)] transition hover:bg-[var(--rc-new-surface-subtle)] disabled:cursor-not-allowed disabled:opacity-35"
          aria-label={language === "vi" ? "Ngày trước" : "Previous day"}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <details ref={dateMenuRef} className="group relative">
          <summary
            data-testid="preview-calendar-trigger"
            className="flex h-10 min-w-56 cursor-pointer list-none items-center justify-center gap-3 rounded-lg border border-[var(--rc-new-border)] bg-[var(--rc-new-surface)] px-4 text-sm font-semibold text-[var(--rc-new-text)] shadow-sm outline-none transition hover:bg-[var(--rc-new-surface-subtle)] focus-visible:ring-2 focus-visible:ring-nq-info [&::-webkit-details-marker]:hidden"
          >
            <CalendarDays
              className="h-4 w-4 text-[var(--rc-new-muted)]"
              aria-hidden
            />
            <span className="capitalize">
              {dateLabel(selectedDate, language)}
            </span>
            <ChevronDown
              className="h-3.5 w-3.5 text-[var(--rc-new-muted)] transition-transform group-open:rotate-180"
              aria-hidden
            />
          </summary>
          <div
            data-testid="preview-calendar-menu"
            className="absolute left-1/2 top-full z-50 mt-3 w-80 -translate-x-1/2 rounded-2xl border border-[var(--rc-new-border)] bg-[var(--rc-new-surface)] p-3 shadow-xl"
          >
            <p className="mb-2 text-xs font-semibold text-[var(--rc-new-muted)]">
              {language === "vi" ? "Chọn ngày và chế độ xem" : "Choose date and view"}
            </p>
            <input
              type="date"
              value={selectedDate}
              data-testid="preview-calendar-date-input"
              aria-label={language === "vi" ? "Chọn ngày" : "Choose date"}
              onChange={(event) => {
                if (!event.target.value) return;
                onSelectDate(event.target.value);
                if (dateMenuRef.current) dateMenuRef.current.open = false;
              }}
              className="min-h-11 w-full rounded-xl border border-[var(--rc-new-border)] bg-[var(--rc-new-surface)] px-3 text-sm font-medium text-[var(--rc-new-text)] outline-none focus-visible:ring-2 focus-visible:ring-nq-info"
            />
            <div
              role="tablist"
              aria-label={language === "vi" ? "Chế độ lịch" : "Calendar view"}
              className="mt-3 grid grid-cols-3 overflow-hidden rounded-xl border border-[var(--rc-new-border)]"
            >
              {(["day", "week", "month"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={viewMode === mode}
                  data-testid={`preview-view-mode-${mode}`}
                  onClick={() => {
                    onViewModeChange(mode);
                    if (dateMenuRef.current) dateMenuRef.current.open = false;
                  }}
                  className={cn(
                    "min-h-11 px-3 text-xs font-semibold transition",
                    viewMode === mode
                      ? "bg-nq-primary/15 text-nq-primary"
                      : "text-[var(--rc-new-muted)] hover:bg-[var(--rc-new-surface-subtle)] hover:text-[var(--rc-new-text)]",
                  )}
                >
                  {mode === "day"
                    ? language === "vi"
                      ? "Ngày"
                      : "Day"
                    : mode === "week"
                      ? language === "vi"
                        ? "Tuần"
                        : "Week"
                      : language === "vi"
                        ? "Tháng"
                        : "Month"}
                </button>
              ))}
            </div>
          </div>
        </details>
        <button
          type="button"
          onClick={() => {
            if (selectedOffset === null) {
              onSelectDate(shiftYmd(selectedDate, 1));
              return;
            }
            onDateChange((selectedOffset + 1) as 0 | 1);
          }}
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

      <div className="flex items-center justify-self-end gap-3">
        <span
          className="inline-flex items-center gap-2 text-xs text-[var(--rc-new-muted)]"
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
        <HeaderCustomerSearch
          slug={slug}
          language={language}
          clientHref={clientHref}
          onSelectClient={onSelectClient}
        />
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
                  className="flex min-h-11 w-full items-center rounded-xl px-3 text-left text-base font-medium text-[var(--rc-new-text)] hover:bg-[var(--rc-new-surface-subtle)]"
                >
                  {language === "vi" ? "Lịch hẹn mới" : "New appointment"}
                </button>
              ) : null}
              {canAddWalkin ? (
                <button
                  type="button"
                  onClick={onAddWalkin}
                  className="flex min-h-11 w-full items-center rounded-xl px-3 text-left text-base font-medium text-[var(--rc-new-text)] hover:bg-[var(--rc-new-surface-subtle)]"
                >
                  {language === "vi" ? "Thêm khách vãng lai" : "Add walk-in"}
                </button>
              ) : null}
              {canAddGroup ? (
                <button
                  type="button"
                  onClick={onAddGroup}
                  className="flex min-h-11 w-full items-center rounded-xl px-3 text-left text-base font-medium text-[var(--rc-new-text)] hover:bg-[var(--rc-new-surface-subtle)]"
                >
                  {language === "vi" ? "Đặt lịch nhóm" : "Group booking"}
                </button>
              ) : null}
            </div>
          </details>
        ) : null}
        <details ref={accountMenuRef} className="group relative">
          <summary
            data-testid="preview-account-trigger"
            className="inline-flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-full border border-[var(--rc-new-border)] bg-[var(--rc-new-surface-subtle)] text-sm font-semibold text-[var(--rc-new-text)] outline-none transition hover:bg-[var(--rc-new-border)] focus-visible:ring-2 focus-visible:ring-nq-info [&::-webkit-details-marker]:hidden"
            aria-label={language === "vi" ? "Mở menu tài khoản" : "Open account menu"}
          >
            {salonInitial}
          </summary>
          <div
            data-testid="preview-account-menu"
            className="absolute right-0 top-full z-50 mt-3 w-64 rounded-2xl border border-[var(--rc-new-border)] bg-[var(--rc-new-surface)] p-2 shadow-xl"
          >
            <div className="border-b border-[var(--rc-new-border)] px-3 py-2">
              <p className="truncate text-sm font-semibold text-[var(--rc-new-text)]">
                {salonName}
              </p>
              <p className="text-xs text-[var(--rc-new-muted)]">
                {language === "vi" ? "Tài khoản salon" : "Salon account"}
              </p>
            </div>
            <Link
              href={ownerHref}
              onClick={() => {
                if (accountMenuRef.current) accountMenuRef.current.open = false;
              }}
              className="mt-1 flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium text-[var(--rc-new-text)] transition hover:bg-[var(--rc-new-surface-subtle)]"
            >
              <LayoutDashboard className="h-4 w-4" aria-hidden />
              {language === "vi" ? "Trang quản lý" : "Owner dashboard"}
            </Link>
            <Link
              href={settingsHref}
              onClick={() => {
                if (accountMenuRef.current) accountMenuRef.current.open = false;
              }}
              className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium text-[var(--rc-new-text)] transition hover:bg-[var(--rc-new-surface-subtle)]"
            >
              <Settings className="h-4 w-4" aria-hidden />
              {language === "vi" ? "Cài đặt" : "Settings"}
            </Link>
            <div className="mt-1 border-t border-[var(--rc-new-border)] px-2 pt-2">
              <LogoutButton language={language} />
            </div>
          </div>
        </details>
      </div>
    </header>
  );
}

export function HeaderCustomerSearch({
  slug,
  language,
  clientHref,
  onSelectClient,
  surface = "desktop",
}: {
  slug: string;
  language: "en" | "vi";
  clientHref: string;
  onSelectClient: (client: ClientSearchHit) => void;
  surface?: "desktop" | "mobile";
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ClientSearchHit[]>([]);
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();
  const testIdPrefix =
    surface === "mobile" ? "mobile-customer-search" : "preview-customer-search";
  const inputId = `${testIdPrefix}-input`;

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onQueryChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setQuery(next);
    setError(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    const normalized = next.trim();
    if (normalized.length < 2) {
      requestRef.current += 1;
      setHits([]);
      return;
    }
    const request = ++requestRef.current;
    timerRef.current = setTimeout(() => {
      startTransition(async () => {
        const result = await searchClients(slug, normalized);
        if (request !== requestRef.current) return;
        if (!result.ok) {
          setHits([]);
          setError(true);
          return;
        }
        setHits(result.hits);
      });
    }, 250);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid={`${testIdPrefix}-trigger`}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-11 w-11 touch-manipulation items-center justify-center rounded-lg border border-nq-border text-nq-foreground outline-none transition hover:bg-nq-surface focus-visible:ring-2 focus-visible:ring-nq-info"
        aria-label={language === "vi" ? "Tìm khách hàng" : "Search customers"}
      >
        <Search className="h-5 w-5" aria-hidden />
      </button>
      {open ? (
        <>
          {surface === "mobile" ? (
            <button
              type="button"
              aria-label={language === "vi" ? "Đóng tìm kiếm" : "Close search"}
              className="fixed inset-0 z-[60] bg-black/55 backdrop-blur-[2px] md:hidden"
              onClick={() => setOpen(false)}
            />
          ) : null}
          <div
            role="dialog"
            aria-modal={surface === "mobile" ? true : undefined}
            aria-label={language === "vi" ? "Tìm khách hàng" : "Search customers"}
            data-testid={testIdPrefix}
            className={cn(
              "z-[70] rounded-2xl border border-nq-border bg-nq-surface p-3 shadow-xl",
              surface === "mobile"
                ? "fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] max-h-[calc(100dvh-1.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] overflow-hidden"
                : "absolute right-0 top-full mt-3 w-80",
            )}
          >
            {surface === "mobile" ? (
              <div className="mb-3 flex min-h-11 items-center justify-between gap-3">
                <p className="text-lg font-semibold text-nq-foreground">
                  {language === "vi" ? "Tìm khách hàng" : "Find customer"}
                </p>
                <button
                  type="button"
                  data-testid={`${testIdPrefix}-close`}
                  onClick={() => setOpen(false)}
                  aria-label={language === "vi" ? "Đóng tìm kiếm" : "Close search"}
                  className="inline-flex h-11 w-11 touch-manipulation items-center justify-center rounded-xl text-nq-muted hover:bg-nq-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-info"
                >
                  <X className="h-5 w-5" aria-hidden />
                </button>
              </div>
            ) : null}
          <label className="sr-only" htmlFor={inputId}>
            {language === "vi" ? "Tên hoặc số điện thoại" : "Name or phone"}
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-nq-muted"
              aria-hidden
            />
            <input
              ref={inputRef}
              id={inputId}
              data-testid={`${testIdPrefix}-input`}
              value={query}
              onChange={onQueryChange}
              placeholder={
                language === "vi" ? "Tên hoặc số điện thoại" : "Name or phone"
              }
              className="min-h-11 w-full rounded-xl border border-nq-border bg-nq-surface pl-9 pr-3 text-base text-nq-foreground outline-none placeholder:text-nq-muted focus-visible:ring-2 focus-visible:ring-nq-info"
            />
          </div>
          <div className="mt-2 max-h-[min(18rem,50dvh)] overflow-y-auto">
            {pending ? (
              <p role="status" className="px-3 py-3 text-base text-nq-muted">
                {language === "vi" ? "Đang tìm…" : "Searching…"}
              </p>
            ) : error ? (
              <p role="alert" className="px-3 py-3 text-base text-nq-error">
                {language === "vi"
                  ? "Không tìm được lúc này. Vui lòng thử lại."
                  : "Search is unavailable. Please try again."}
              </p>
            ) : query.trim().length < 2 ? (
              <p className="px-3 py-3 text-base text-nq-muted">
                {language === "vi"
                  ? "Nhập ít nhất 2 ký tự."
                  : "Enter at least 2 characters."}
              </p>
            ) : hits.length === 0 ? (
              <p className="px-3 py-3 text-base text-nq-muted">
                {language === "vi" ? "Không tìm thấy khách." : "No customers found."}
              </p>
            ) : (
              hits.map((hit) => (
                <button
                  key={hit.phone}
                  type="button"
                  onClick={() => {
                    onSelectClient(hit);
                    setOpen(false);
                  }}
                  data-testid={`${testIdPrefix}-result`}
                  className="flex min-h-12 w-full touch-manipulation items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-nq-surface"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-base font-semibold text-nq-foreground">
                      {hit.name ||
                        (language === "vi" ? "Khách chưa có tên" : "Unnamed customer")}
                    </span>
                    <span className="block text-base text-nq-muted">
                      {formatPhone(hit.phone)}
                    </span>
                  </span>
                  <span className="shrink-0 text-base font-medium text-nq-primary">
                    {language === "vi" ? "Đặt lịch" : "Book"}
                  </span>
                </button>
              ))
            )}
          </div>
          <Link
            href={clientHref}
            className="mt-2 flex min-h-11 items-center justify-center rounded-xl border border-nq-border text-base font-semibold text-nq-foreground transition hover:bg-nq-surface"
          >
            {language === "vi" ? "Xem tất cả khách hàng" : "View all customers"}
          </Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
