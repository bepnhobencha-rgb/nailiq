"use client";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { salonYmdOfUtc } from "@/shared/lib/salonTime";
import { ownerRemovalCopyEn } from "@/shared/i18n/user/en";
import { ownerRemovalCopyVi } from "@/shared/i18n/user/vi";
import { reconcileOwnerCardRemoval, type RemovalExceptionsResult } from "@/shared/booking/ownerCardRemovalActions";

export function OwnerCardRemovalExceptions({ slug, result, timezone }: {
  slug: string; result: RemovalExceptionsResult; timezone: string;
}) {
  const { language } = useUserLanguage(); const copy = language === "vi" ? ownerRemovalCopyVi : ownerRemovalCopyEn;
  const [pending, startTransition] = useTransition(); const locked = useRef(false);
  const [message, setMessage] = useState<"success" | "unresolved" | "failed" | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const date = (value: string) => new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-CA", {
    timeZone: timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
  function check(operationId: string) {
    if (locked.current) return;
    locked.current = true; setActive(operationId); setMessage(null);
    startTransition(async () => {
      try { const outcome = await reconcileOwnerCardRemoval(slug, operationId); setMessage(outcome.ok ? "success" : "unresolved"); }
      catch { setMessage("failed"); }
      finally { locked.current = false; setActive(null); }
    });
  }
  return <section data-testid="owner-card-removal-exceptions" className="mt-4 rounded-2xl border border-nq-border bg-nq-surface p-4">
    <h2 className="text-lg font-semibold text-nq-text">{copy.title}</h2>
    <p className="mt-2 text-sm text-nq-muted">{copy.intro}</p>
    {!result.ok ? <p role="alert" className="mt-3 text-sm text-nq-warning">{copy.loadError}</p> : null}
    {result.ok && result.items.length === 0 ? <p className="mt-3 text-sm text-nq-muted">{copy.empty}</p> : null}
    <div className="mt-4 space-y-3">{result.items.map(item => <article key={item.operationId} data-testid="removal-exception" className="rounded-xl border border-nq-border p-3">
      <p className="font-semibold text-nq-text">{item.clientLabel} · {item.service}</p>
      <p className="mt-1 text-sm text-nq-muted">{date(item.startTime)}</p>
      <p className="mt-2 text-sm font-medium text-nq-warning">{copy.pending}</p>
      <p className="mt-1 text-sm text-nq-muted">{copy.reasons[item.reason as keyof typeof copy.reasons] ?? copy.reasons.unknown}</p>
      <p className="mt-1 text-sm text-nq-muted">{copy.last}{date(item.lastAttemptAt)}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a className="inline-flex min-h-11 items-center rounded-xl border border-nq-border px-3 py-2 text-sm text-nq-text" href={`/dashboard/${encodeURIComponent(slug)}/center?date=${salonYmdOfUtc(item.startTime, timezone)}&booking=${encodeURIComponent(item.bookingId)}`}>{copy.open}</a>
        <Button variant="secondary" size="lg" disabled={pending || !item.canReconcile} loading={pending && active === item.operationId} onClick={() => check(item.operationId)}>{copy.check}</Button>
      </div>
      {!item.canReconcile ? <p className="mt-2 text-sm text-nq-muted">{copy.reviewRequired}</p> : null}
    </article>)}</div>
    {result.hasMore ? <p className="mt-3 text-sm text-nq-muted">{copy.more}</p> : null}
    {message ? <p role="status" className="mt-3 text-sm text-nq-muted">{copy[message]}</p> : null}
  </section>;
}
