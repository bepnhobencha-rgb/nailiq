"use client";

import { useEffect, useRef, useState } from "react";

import { refreshCustomerWaitState } from "@/shared/booking/loadCustomerWaitStateAction";
import type { CustomerWaitState } from "@/shared/booking/loadCustomerWaitState";
import {
  formatCustomerWaitReadyClock,
  resolveCustomerWaitSurface,
} from "@/shared/booking/customerWaitPresentation";
import { createClient } from "@/shared/lib/supabase/client";
import { cn } from "@/shared/lib/cn";
import { getCustomerWaitMessages } from "@/shared/i18n/customerWait";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

/**
 * Client surface of the public wait page. Subscribes to realtime
 * updates on the bookings row and falls back to a 30s poll when the
 * realtime channel can't connect (offline / blocked sockets / first
 * paint before subscribe completes).
 */

const POLL_INTERVAL_MS = 30_000;

type ReadyState = Extract<CustomerWaitState, { ok: true }>;

export function CustomerWaitClient({
  slug,
  bookingId,
  initialState,
  manageLinks,
}: {
  slug: string;
  bookingId: string;
  initialState: ReadyState;
  /** Token-backed reschedule/cancel URLs, or null once the booking is over. */
  manageLinks: { reschedule: string; cancel: string } | null;
}) {
  const [state, setState] = useState<ReadyState>(initialState);
  const { language } = useUserLanguage();
  const messages = getCustomerWaitMessages(language);

  // Realtime + polling refresh. The polling fallback fires
  // unconditionally; the realtime tick simply forces a refresh
  // sooner than the next poll when an update lands.
  const refreshRef = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const seq = ++refreshRef.current;
      try {
        const r = await refreshCustomerWaitState(slug, bookingId);
        if (cancelled || seq !== refreshRef.current) return;
        if (r.ok) setState(r);
      } catch {
        /* swallow — keep last good state */
      }
    };

    const supabase = createClient();
    const channel = supabase
      .channel(`wait:${bookingId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "bookings",
          filter: `id=eq.${bookingId}`,
        },
        () => {
          void refresh();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "bookings",
        },
        () => {
          // Any other row changing means the queue may have shifted —
          // refresh so the position number stays current.
          void refresh();
        },
      )
      .subscribe();

    const poll = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [slug, bookingId]);

  const surface = resolveCustomerWaitSurface(
    state.booking.kind,
    state.booking.status,
  );

  if (surface === "appointment") {
    return (
      <AppointmentScreen
        state={state}
        messages={messages}
        manageLinks={manageLinks}
        language={language}
      />
    );
  }
  if (surface === "ready") {
    return <ReadyScreen state={state} messages={messages} />;
  }
  if (surface === "done") {
    return <DoneScreen state={state} messages={messages} />;
  }
  if (surface === "cancelled") {
    return <CancelledScreen state={state} messages={messages} />;
  }

  return (
    <WaitingScreen state={state} messages={messages} manageLinks={manageLinks} />
  );
}

function AppointmentScreen({
  state,
  messages,
  manageLinks,
  language,
}: {
  state: ReadyState;
  messages: ReturnType<typeof getCustomerWaitMessages>;
  manageLinks: { reschedule: string; cancel: string } | null;
  language: "en" | "vi";
}) {
  const appointmentTime = state.booking.startTimeUtc
    ? new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-CA", {
        timeZone: state.salon.timezone,
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(state.booking.startTimeUtc))
    : "—";

  return (
    <PageShell testId="customer-wait-appointment" className="bg-nq-bg">
      <SalonHeader name={state.salon.name} />
      <p className="mt-3 text-center text-sm text-nq-muted">
        {messages.greeting.replace("{name}", state.booking.clientName)}
      </p>

      <section className="mt-6 rounded-2xl border border-emerald-500/35 bg-emerald-500/10 px-5 py-6 text-center">
        <span
          aria-hidden
          className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-emerald-500 text-xl font-bold text-nq-bg"
        >
          ✓
        </span>
        <h2 className="mt-3 text-xl font-semibold text-nq-foreground">
          {messages.appointmentConfirmed}
        </h2>
      </section>

      <SectionDivider label={messages.appointmentDateLabel} />
      <time
        dateTime={state.booking.startTimeUtc ?? undefined}
        data-testid="customer-wait-appointment-time"
        className="block text-center text-base font-semibold text-nq-foreground"
      >
        {appointmentTime}
      </time>

      <SectionDivider label={messages.serviceLabel} />
      <p className="text-center text-sm text-nq-foreground">
        {state.booking.serviceName}
        {state.staffName ? (
          <span className="text-nq-muted"> · {state.staffName}</span>
        ) : null}
      </p>

      <p className="mt-6 text-center text-sm leading-6 text-nq-muted">
        {messages.appointmentConfirmedNote}
      </p>
      <ManageActions manageLinks={manageLinks} messages={messages} />
    </PageShell>
  );
}

/** Reschedule / cancel actions. Rendered only while the booking is still
 *  upcoming — once it is in progress, done or cancelled, changing it is a
 *  conversation with the front desk rather than a self-service action. */
function ManageActions({
  manageLinks,
  messages,
}: {
  manageLinks: { reschedule: string; cancel: string } | null;
  messages: ReturnType<typeof getCustomerWaitMessages>;
}) {
  if (!manageLinks) return null;
  return (
    <div
      data-testid="customer-wait-manage"
      className="mt-8 flex flex-col gap-2 sm:flex-row sm:justify-center"
    >
      <a
        href={manageLinks.reschedule}
        data-testid="customer-wait-reschedule"
        className="rounded-xl border border-nq-border px-5 py-3 text-center text-sm font-semibold text-nq-foreground transition-colors hover:bg-white/5"
      >
        {messages.rescheduleCta}
      </a>
      <a
        href={manageLinks.cancel}
        data-testid="customer-wait-cancel"
        className="rounded-xl px-5 py-3 text-center text-sm text-nq-muted underline-offset-4 transition-colors hover:underline"
      >
        {messages.cancelCta}
      </a>
    </div>
  );
}

function PageShell({
  children,
  className,
  testId,
}: {
  children: React.ReactNode;
  className?: string;
  testId: string;
}) {
  return (
    <main
      data-testid={testId}
      className={cn(
        "flex min-h-[100dvh] w-full flex-col items-center justify-center px-4 py-8",
        className,
      )}
    >
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}

function SalonHeader({ name }: { name: string }) {
  return (
    <h1 className="text-center text-base font-bold uppercase tracking-[0.18em] text-nq-foreground">
      {name}
    </h1>
  );
}

function WaitingScreen({
  state,
  messages,
  manageLinks,
}: {
  state: ReadyState;
  messages: ReturnType<typeof getCustomerWaitMessages>;
  manageLinks: { reschedule: string; cancel: string } | null;
}) {
  const readyClock = state.readyAroundIso
    ? formatCustomerWaitReadyClock(
        state.readyAroundIso,
        state.salon.timezone,
      )
    : null;
  const positionLabel =
    state.queuePosition != null
      ? `#${state.queuePosition}`
      : messages.assigned;
  const waitMin = state.estimatedWaitMinutes;

  return (
    <PageShell testId="customer-wait-waiting" className="bg-nq-bg">
      <SalonHeader name={state.salon.name} />
      <p className="mt-3 text-center text-sm text-nq-muted">
        {messages.greeting.replace("{name}", state.booking.clientName)}
      </p>

      <section
        className="mt-6 rounded-2xl border border-nq-muted/30 bg-nq-surface px-5 py-6 text-center"
        aria-live="polite"
      >
        <p className="text-xs uppercase tracking-wide text-nq-muted">
          {messages.yourPosition}
        </p>
        <p
          data-testid="customer-wait-position"
          className="mt-1 font-mono text-5xl font-bold tabular-nums text-nq-foreground"
        >
          {positionLabel}
        </p>
      </section>

      <section className="mt-3 rounded-2xl border border-nq-muted/30 bg-nq-surface px-5 py-6 text-center">
        <p className="text-xs uppercase tracking-wide text-nq-muted">
          {messages.estimatedWait}
        </p>
        <p
          data-testid="customer-wait-eta"
          className="mt-1 font-mono text-3xl font-bold tabular-nums text-nq-foreground"
        >
          {waitMin == null
            ? "—"
            : waitMin <= 0
              ? messages.readyNow
              : messages.minutesShort(waitMin)}
        </p>
        {readyClock ? (
          <p className="mt-1 text-xs text-nq-muted">
            {messages.readyAround.replace("{time}", readyClock)}
          </p>
        ) : null}
      </section>

      <SectionDivider label={messages.serviceLabel} />
      <p className="text-center text-sm text-nq-foreground">
        {state.booking.serviceName}
        {state.staffName ? (
          <span className="text-nq-muted"> · {state.staffName}</span>
        ) : null}
      </p>

      <SectionDivider label={messages.statusLabel} />
      <p className="text-center text-sm text-nq-foreground">
        <span aria-hidden>🟡 </span>
        {messages.statusWaiting}
        {state.queuePosition != null ? ` · ${positionLabel}` : ""}
      </p>

      <ManageActions manageLinks={manageLinks} messages={messages} />

      <p className="mt-8 text-center text-xs text-nq-muted">
        {messages.autoRefreshNote}
      </p>
    </PageShell>
  );
}

function ReadyScreen({
  state,
  messages,
}: {
  state: ReadyState;
  messages: ReturnType<typeof getCustomerWaitMessages>;
}) {
  return (
    <PageShell
      testId="customer-wait-ready"
      className="bg-emerald-500/95 text-emerald-50 motion-safe:animate-pulse"
    >
      <SalonHeader name={state.salon.name} />
      <p className="mt-3 text-center text-sm opacity-85">
        {messages.greeting.replace("{name}", state.booking.clientName)}
      </p>
      <section className="mt-8 rounded-3xl border border-white/35 bg-white/10 px-5 py-10 text-center">
        <p className="text-5xl">🎉</p>
        <p className="mt-4 text-2xl font-bold">{messages.itsYourTurn}</p>
        <p className="mt-2 text-sm opacity-90">{messages.pleaseComeIn}</p>
        {state.staffName ? (
          <p className="mt-3 text-base font-semibold">
            {messages.withStaff.replace("{name}", state.staffName)}
          </p>
        ) : null}
      </section>
    </PageShell>
  );
}

function DoneScreen({
  state,
  messages,
}: {
  state: ReadyState;
  messages: ReturnType<typeof getCustomerWaitMessages>;
}) {
  return (
    <PageShell testId="customer-wait-done" className="bg-nq-bg">
      <SalonHeader name={state.salon.name} />
      <section className="mt-8 rounded-3xl border border-nq-muted/30 bg-nq-surface px-5 py-10 text-center">
        <p className="text-5xl">💛</p>
        <p className="mt-4 text-lg font-semibold text-nq-foreground">
          {messages.thankYou.replace("{salon}", state.salon.name)}
        </p>
        <p className="mt-2 text-sm text-nq-muted">{messages.seeYouAgain}</p>
      </section>
    </PageShell>
  );
}

function CancelledScreen({
  state,
  messages,
}: {
  state: ReadyState;
  messages: ReturnType<typeof getCustomerWaitMessages>;
}) {
  return (
    <PageShell testId="customer-wait-cancelled" className="bg-nq-bg">
      <SalonHeader name={state.salon.name} />
      <section className="mt-8 rounded-3xl border border-nq-muted/30 bg-nq-surface px-5 py-10 text-center">
        <p className="text-5xl opacity-60">·</p>
        <p className="mt-4 text-base font-semibold text-nq-foreground">
          {messages.cancelled}
        </p>
      </section>
    </PageShell>
  );
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="mt-6 mb-2 flex items-center gap-2">
      <span className="h-px flex-1 bg-nq-muted/30" aria-hidden />
      <span className="text-[10px] font-semibold uppercase tracking-wide text-nq-muted">
        {label}
      </span>
      <span className="h-px flex-1 bg-nq-muted/30" aria-hidden />
    </div>
  );
}
