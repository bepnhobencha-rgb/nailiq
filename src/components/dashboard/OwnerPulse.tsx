"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { cn } from "@/shared/lib/cn";
import { GlobalLanguageToggle } from "@/components/user/GlobalLanguageToggle";
import type {
  OwnerPulseData,
  PulseAttentionKind,
} from "@/shared/dashboard/loadOwnerPulse";

type Lang = "en" | "vi";

const COPY = {
  vi: {
    greetingMorning: "Chào buổi sáng",
    greetingAfternoon: "Chào buổi chiều",
    greetingEvening: "Chào buổi tối",
    updatedNow: "vừa cập nhật",
    updatedAgo: (m: number) => `cập nhật ${m} phút trước`,
    refresh: "Làm mới",
    enterFullscreen: "Toàn màn hình",
    exitFullscreen: "Thoát toàn màn hình",
    busyTitle: "Nhịp tiệm",
    units: {
      bed: "giường đang dùng",
      chair: "ghế đang có khách",
      room: "phòng đang dùng",
      station: "chỗ đang dùng",
      staff: "thợ đang làm",
    },
    statusBusy: "Đông khách",
    statusRunning: "Đang chạy",
    statusQuiet: "Vắng khách",
    statusEmpty: "Chưa có ai",
    revenueToday: "Doanh thu hôm nay",
    vsLastWeek: (p: number) => `${p}% so với cùng ngày tuần trước`,
    noBench: "Chưa có dữ liệu tuần trước để so",
    done: "Xong",
    remaining: "Còn lại",
    noShow: "No-show",
    walkin: "Khách vãng lai",
    attentionTitle: "Cần chú ý",
    allGood: "Mọi thứ đang ổn",
    allGoodSub: "Không có gì cần xử lý ngay bây giờ.",
    att: {
      overdue: (n: number) => `${n} hẹn đang trễ giờ (quá giờ kết thúc)`,
      not_started: (n: number) => `${n} hẹn tới giờ mà chưa bắt đầu`,
      no_show_risk: (n: number) => `${n} hẹn có nguy cơ no-show hôm nay`,
      tomorrow_low: (n: number) =>
        n === 0
          ? "Ngày mai chưa có hẹn nào"
          : `Ngày mai mới có ${n} hẹn — hơi vắng`,
    },
    teamTitle: "Đang làm",
    teamBusy: "đang phục vụ",
    teamFree: "đang rảnh",
    noStaff: "Chưa có thợ active",
    callSalon: "Gọi tiệm",
    liveBoard: "Bảng Live",
    calendar: "Lịch hẹn",
  },
  en: {
    greetingMorning: "Good morning",
    greetingAfternoon: "Good afternoon",
    greetingEvening: "Good evening",
    updatedNow: "just updated",
    updatedAgo: (m: number) => `updated ${m}m ago`,
    refresh: "Refresh",
    enterFullscreen: "Fullscreen",
    exitFullscreen: "Exit fullscreen",
    busyTitle: "Salon pulse",
    units: {
      bed: "beds in service",
      chair: "chairs in service",
      room: "rooms in service",
      station: "stations in service",
      staff: "staff working",
    },
    statusBusy: "Slammed",
    statusRunning: "Humming",
    statusQuiet: "Quiet",
    statusEmpty: "Nobody in",
    revenueToday: "Revenue today",
    vsLastWeek: (p: number) => `${p}% vs same day last week`,
    noBench: "No data from last week to compare",
    done: "Done",
    remaining: "To go",
    noShow: "No-show",
    walkin: "Walk-ins",
    attentionTitle: "Needs attention",
    allGood: "All good",
    allGoodSub: "Nothing needs you right now.",
    att: {
      overdue: (n: number) => `${n} appointment(s) running overdue`,
      not_started: (n: number) => `${n} appointment(s) past start, not begun`,
      no_show_risk: (n: number) => `${n} no-show risk today`,
      tomorrow_low: (n: number) =>
        n === 0
          ? "Tomorrow has no bookings yet"
          : `Only ${n} booked tomorrow — looks light`,
    },
    teamTitle: "Working now",
    teamBusy: "in service",
    teamFree: "free",
    noStaff: "No active staff",
    callSalon: "Call salon",
    liveBoard: "Live Board",
    calendar: "Calendar",
  },
} as const;

function money(cents: number): string {
  const dollars = (cents || 0) / 100;
  return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function salonHour(tz: string): number {
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      // h23 so midnight is "00" not "24" (h24 runtimes returned 24 → the
      // 00:00–00:59 hour was misread as 24 → wrong "evening" greeting).
      hourCycle: "h23",
      timeZone: tz,
    }).format(new Date());
    return (parseInt(s, 10) || 0) % 24;
  } catch {
    return new Date().getHours();
  }
}

const ATT_TONE: Record<PulseAttentionKind, string> = {
  overdue: "border-nq-error/40 bg-nq-error/10 text-nq-error",
  not_started: "border-nq-warning/40 bg-nq-warning/10 text-nq-warning",
  no_show_risk: "border-nq-warning/40 bg-nq-warning/10 text-nq-warning",
  tomorrow_low: "border-nq-info/40 bg-nq-info/10 text-nq-info",
};

export function OwnerPulse({
  slug,
  language,
  data,
}: {
  slug: string;
  language: Lang;
  data: OwnerPulseData;
}) {
  const t = COPY[language];
  const router = useRouter();

  // Live "updated N min ago" + 60s auto-refresh so the away owner always
  // sees a fresh picture without manual reload.
  const [agoMin, setAgoMin] = useState(0);
  useEffect(() => {
    const gen = Date.parse(data.generatedAtUtc);
    const tick = () =>
      setAgoMin(Math.max(0, Math.floor((Date.now() - gen) / 60000)));
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [data.generatedAtUtc]);

  useEffect(() => {
    const id = setInterval(() => router.refresh(), 60000);
    return () => clearInterval(id);
  }, [router]);

  // Refresh + fullscreen are now the shared DashboardViewControls (top-right on
  // every page) — Pulse keeps only its 60s auto-refresh above.
  //
  // Compute the time-based greeting AFTER mount: salonHour() reads the live
  // clock, which differs between SSR and hydration and would mismatch at an
  // hour boundary. Render a stable non-breaking-space placeholder through
  // hydration, then swap in the real greeting.
  const [hour, setHour] = useState<number | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe: live-clock greeting computed after mount
    setHour(salonHour(data.timezone));
  }, [data.timezone]);
  const greeting =
    hour === null
      ? " "
      : hour < 12
        ? t.greetingMorning
        : hour < 18
          ? t.greetingAfternoon
          : t.greetingEvening;

  const ratio =
    data.chairsTotal > 0 ? data.chairsBusy / data.chairsTotal : 0;
  const tone =
    data.chairsBusy === 0
      ? "empty"
      : ratio >= 0.75
        ? "busy"
        : ratio >= 0.34
          ? "running"
          : "quiet";
  const toneColor = {
    busy: "#D97706", // amber — slammed
    running: "#D4AF37", // gold — humming
    quiet: "#3B82F6", // blue — quiet
    empty: "#A1A1AA", // muted — nobody
  }[tone];
  const toneLabel = {
    busy: t.statusBusy,
    running: t.statusRunning,
    quiet: t.statusQuiet,
    empty: t.statusEmpty,
  }[tone];

  const benchPct =
    data.revenueBenchmarkCents > 0
      ? Math.round((data.revenueTodayCents / data.revenueBenchmarkCents) * 100)
      : null;

  return (
    <div className="space-y-4">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-nq-muted">{greeting}</p>
          <h1 className="truncate text-2xl font-semibold tracking-tight text-nq-foreground">
            {data.salonName}
          </h1>
          <p className="mt-0.5 text-[11px] text-nq-muted">
            {agoMin === 0 ? t.updatedNow : t.updatedAgo(agoMin)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pr-20">
          {/* Refresh + fullscreen moved to the shared top-right
              DashboardViewControls; pr-20 keeps the toggle clear of it. */}
          <GlobalLanguageToggle />
        </div>
      </header>

      {/* Two-column on desktop (lg+), single stacked column on phone.
          Same content, laid out for where it's opened. */}
      <div className="space-y-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-5 lg:space-y-0">
        {/* Column A — live status + money headline */}
        <div className="space-y-4">

      {/* ── Pulse ring ─────────────────────────────────────── */}
      <section className="flex flex-col items-center rounded-3xl border border-nq-border/50 bg-nq-surface/40 py-7">
        <p className="text-[11px] font-medium uppercase tracking-wide text-nq-muted">
          {t.busyTitle}
        </p>
        <div className="relative mt-3 flex h-44 w-44 items-center justify-center">
          {/* Pulsing halo — only when someone is actually in service. */}
          {data.chairsBusy > 0 ? (
            <>
              <span
                className="absolute inline-flex h-32 w-32 animate-ping rounded-full opacity-20"
                style={{ backgroundColor: toneColor, animationDuration: "2.4s" }}
              />
              <span
                className="absolute inline-flex h-24 w-24 animate-ping rounded-full opacity-25"
                style={{ backgroundColor: toneColor, animationDuration: "2.4s", animationDelay: "0.6s" }}
              />
            </>
          ) : null}
          <svg viewBox="0 0 120 120" className="h-44 w-44 -rotate-90">
            <circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" strokeWidth="8" className="text-nq-border/40" />
            <circle
              cx="60"
              cy="60"
              r="52"
              fill="none"
              stroke={toneColor}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 52}
              strokeDashoffset={2 * Math.PI * 52 * (1 - Math.max(ratio, data.chairsBusy > 0 ? 0.06 : 0))}
              style={{ transition: "stroke-dashoffset 700ms cubic-bezier(0.22,1,0.36,1)" }}
            />
          </svg>
          <div className="absolute flex flex-col items-center">
            <span className="text-4xl font-bold tabular-nums text-nq-foreground">
              {data.chairsBusy}
              <span className="text-2xl text-nq-muted">/{data.chairsTotal}</span>
            </span>
            <span
              className="mt-1 rounded-full px-2.5 py-0.5 text-xs font-semibold"
              style={{ color: toneColor, backgroundColor: `${toneColor}1f` }}
            >
              {toneLabel}
            </span>
          </div>
        </div>
        <p className="mt-2 text-xs text-nq-muted">
          {t.units[data.capacityKind]}
        </p>
      </section>

      {/* ── AI briefing ────────────────────────────────────── */}
      {data.briefing ? (
        <section className="rounded-2xl border border-nq-primary/25 bg-nq-primary/[0.06] p-4">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="#D4AF37" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3l1.9 4.8L18.7 9l-4.8 1.2L12 15l-1.9-4.8L5.3 9l4.8-1.2L12 3z" />
            </svg>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-nq-primary">AI</span>
          </div>
          <p className="mt-2 text-[15px] leading-relaxed text-nq-foreground/95">
            {data.briefing}
          </p>
        </section>
      ) : null}

      {/* ── Revenue vs goal ────────────────────────────────── */}
      <section className="rounded-2xl border border-nq-border/50 bg-nq-surface/40 p-4">
        <div className="flex items-end justify-between gap-2">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-nq-muted">
              {t.revenueToday}
            </p>
            <p className="mt-0.5 text-3xl font-bold tabular-nums text-nq-primary">
              {money(data.revenueTodayCents)}
            </p>
          </div>
          {benchPct != null ? (
            <span
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums",
                benchPct >= 100
                  ? "bg-nq-success/15 text-nq-success"
                  : benchPct >= 70
                    ? "bg-nq-warning/15 text-nq-warning"
                    : "bg-nq-error/15 text-nq-error",
              )}
            >
              {benchPct >= 100 ? "▲" : "▼"} {benchPct}%
            </span>
          ) : null}
        </div>
        {benchPct != null ? (
          <>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-nq-bg/70">
              <div
                className="h-full rounded-full transition-[width] duration-700"
                style={{
                  width: `${Math.min(benchPct, 100)}%`,
                  backgroundColor: benchPct >= 100 ? "#22C55E" : "#D4AF37",
                }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-nq-muted">{t.vsLastWeek(benchPct)}</p>
          </>
        ) : (
          <p className="mt-2 text-[11px] text-nq-muted">{t.noBench}</p>
        )}
      </section>

        </div>
        {/* Column B — what to act on */}
        <div className="space-y-4">

      {/* ── Today scorecard ────────────────────────────────── */}
      <section className="grid grid-cols-4 gap-2">
        <MiniStat label={t.done} value={data.completedToday} />
        <MiniStat label={t.remaining} value={data.remainingToday} accent="gold" />
        <MiniStat label={t.noShow} value={data.noShowToday} accent={data.noShowToday > 0 ? "red" : undefined} />
        <MiniStat label={t.walkin} value={data.walkinToday} />
      </section>

      {/* ── Attention ──────────────────────────────────────── */}
      <section className="space-y-2">
        <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
          {t.attentionTitle}
        </p>
        {data.attention.length === 0 ? (
          <div className="flex items-center gap-3 rounded-2xl border border-nq-success/30 bg-nq-success/[0.07] px-4 py-3.5">
            <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="#22C55E" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <path d="M8 12l3 3 5-6" />
            </svg>
            <div>
              <p className="text-sm font-semibold text-nq-foreground">{t.allGood}</p>
              <p className="text-xs text-nq-muted">{t.allGoodSub}</p>
            </div>
          </div>
        ) : (
          data.attention.map((a) => (
            <Link
              key={a.kind}
              href={`/dashboard/${encodeURIComponent(slug)}/center`}
              className={cn(
                "flex items-center justify-between gap-3 rounded-2xl border px-4 py-3.5 transition-opacity active:opacity-70",
                ATT_TONE[a.kind],
              )}
            >
              <span className="text-sm font-medium">{t.att[a.kind](a.count)}</span>
              <span aria-hidden className="shrink-0 opacity-70">→</span>
            </Link>
          ))
        )}
      </section>

      {/* ── Team ───────────────────────────────────────────── */}
      <section className="rounded-2xl border border-nq-border/50 bg-nq-surface/40 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
          {t.teamTitle}
        </p>
        {data.staff.length === 0 ? (
          <p className="mt-2 text-sm text-nq-muted">{t.noStaff}</p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-3">
            {data.staff.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-nq-bg/70 text-xs font-semibold text-nq-foreground ring-1 ring-nq-border/60">
                  {s.name.slice(0, 2).toUpperCase()}
                  <span
                    className={cn(
                      "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-nq-surface",
                      s.status === "busy" ? "bg-nq-warning" : "bg-nq-success",
                    )}
                  />
                </span>
                <span className="text-xs text-nq-muted">
                  <span className="block font-medium text-nq-foreground">{s.name}</span>
                  {s.status === "busy" ? t.teamBusy : t.teamFree}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Quick actions ──────────────────────────────────── */}
      <section className="grid grid-cols-3 gap-2">
        {data.salonPhone ? (
          <QuickAction href={`tel:${data.salonPhone}`} label={t.callSalon}
            icon={<path d="M5 4h4l2 5-3 2a12 12 0 005 5l2-3 5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z" />} />
        ) : (
          <span />
        )}
        <QuickAction href={`/dashboard/${encodeURIComponent(slug)}/center`} label={t.liveBoard}
          icon={<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>} />
        <QuickAction href={`/dashboard/${encodeURIComponent(slug)}/center?view=week`} label={t.calendar}
          icon={<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M3 10h18M8 2v4M16 2v4" /></>} />
      </section>
        </div>
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "gold" | "red";
}) {
  return (
    <div className="rounded-xl border border-nq-border/40 bg-nq-surface/40 px-2 py-3 text-center">
      <p
        className={cn(
          "text-xl font-bold tabular-nums",
          accent === "gold" && "text-nq-primary",
          accent === "red" && "text-nq-error",
          !accent && "text-nq-foreground",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-nq-muted">
        {label}
      </p>
    </div>
  );
}

function QuickAction({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col items-center gap-1.5 rounded-2xl border border-nq-border/50 bg-nq-surface/40 px-2 py-3.5 text-nq-foreground transition-colors hover:border-nq-primary/40 hover:text-nq-primary active:opacity-70"
    >
      <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {icon}
      </svg>
      <span className="text-[11px] font-medium">{label}</span>
    </Link>
  );
}
