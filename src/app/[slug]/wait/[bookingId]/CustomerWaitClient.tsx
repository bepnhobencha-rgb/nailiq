"use client";

import { useEffect, useRef, useState } from "react";

import { refreshCustomerWaitState } from "@/shared/booking/loadCustomerWaitStateAction";
import type { CustomerWaitState } from "@/shared/booking/loadCustomerWaitState";
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
}: {
  slug: string;
  bookingId: string;
  initialState: ReadyState;
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

  const status = state.booking.status;
  const isReady = status === "in_progress";
  const isDone = status === "completed";
  const isCancelled = status === "cancelled" || status === "no_show";

  if (isReady) return <ReadyScreen state={state} messages={messages} />;
  if (isDone) return <DoneScreen state={state} messages={messages} />;
  if (isCancelled) return <CancelledScreen state={state} messages={messages} />;

  return <WaitingScreen state={state} messages={messages} />;
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
}: {
  state: ReadyState;
  messages: ReturnType<typeof getCustomerWaitMessages>;
}) {
  const readyClock = state.readyAroundIso
    ? new Date(state.readyAroundIso).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
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
