"use client";
import { Button } from "@/components/ui/Button";
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { isCardProtectionStatus, type CardProtectionStatus } from "@/shared/booking/cardProtection";
import { recoverBookingCardAction } from "@/shared/booking/recoverBookingCardAction";
import type { BookingMessages } from "@/shared/i18n/booking/en";

type Context = { protectionStatus: CardProtectionStatus; canRetry: boolean; cancelled: boolean; canRefreshConsent: boolean; consent: { version: string; policyEn: string; policyVi: string } | null };
export function CardProtectionRecovery<P extends object>({ token, t, Capture, captureProps }: {
  token: string; t: BookingMessages; captureProps: P;
  Capture: ComponentType<P & { managementToken: string; onSettled: () => Promise<void> }>;
}) {
  const [context, setContext] = useState<Context | null>(null);
  const [consented, setConsented] = useState(false);
  const [activeToken, setActiveToken] = useState<string | null>(null);
  const [error, setError] = useState<"unavailable" | "expired" | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const copy = t.cardProtection;
  const load = useCallback((): Promise<void> => {
    const requestGeneration = ++generation.current;
    return fetch(`/api/booking/save-card-context?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (response) => {
        const value = await response.json();
        if (!mounted.current || requestGeneration !== generation.current) return;
        if (!response.ok || value.ok !== true || !isCardProtectionStatus(value.protectionStatus)) {
          setError(response.status === 400 || response.status === 404 ? "expired" : "unavailable"); setContext(null); return;
        }
        setContext({ protectionStatus:value.protectionStatus,canRetry:value.canRetry === true,cancelled:value.cancelled === true,
          canRefreshConsent:value.canRefreshConsent === true,consent:value.consent ?? null });
        setError(null);
      }).catch(() => {
        if (mounted.current && requestGeneration === generation.current) { setError("unavailable"); setContext(null); }
      });
  }, [token]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; generation.current += 1; };
  }, [load]);
  const settled = useCallback(async () => { setActiveToken(null); await load(); }, [load]);
  async function retry() {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      const result = await recoverBookingCardAction(token, context?.canRefreshConsent && context.consent && consented
        ? { accepted: true, policyVersion: context.consent.version } : undefined);
      await load();
      if (mounted.current && result.ok && result.managementToken) setActiveToken(result.managementToken);
    } catch { if (mounted.current) setError("unavailable"); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const status = context?.protectionStatus;
  return (
    <section className="rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4 text-[var(--booking-text)]" data-testid="card-protection-recovery" data-protection-status={status ?? "unavailable"}>
      <div role="status" aria-live="polite">
        {context ? <p className="text-sm font-semibold">{status === "saved" ? copy.active : copy.reserved}</p> : null}
        <p className="mt-2 text-sm leading-6 text-[var(--booking-text-muted)]">
          {error ? copy[error] : !context ? copy.checking : status === "saved" ? copy.noCharge : status === "not_required" ? copy.notRequired : copy.pending}
        </p>
        {status === "manual_review" ? <p className="mt-2 text-sm">{copy.review}</p> : null}
        {status === "saving" || status === "reconciliation_pending" ? <p className="mt-2 text-sm">{copy.reconciling}</p> : null}
      </div>
      {context?.canRefreshConsent && context.consent ? <div className="mt-3">
        <details><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">{copy.policyLabel}</summary>
          <p className="whitespace-pre-wrap text-sm leading-6">{copy.policyLanguage === "vi" ? context.consent.policyVi : context.consent.policyEn}</p>
        </details>
        <label className="flex min-h-11 items-start gap-3 py-3 text-sm leading-6">
          <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={consented} onChange={(event) => setConsented(event.target.checked)} />
          {copy.consentLabel}
        </label>
      </div> : null}
      {activeToken && context?.canRetry && !context.cancelled ? <Capture {...captureProps} managementToken={activeToken} onSettled={settled} /> :
        (context || error === "unavailable") && status !== "saved" && status !== "not_required" && error !== "expired" && !context?.cancelled ? (
          <Button type="button" size="lg" fullWidth loading={busy} onClick={() => void retry()} disabled={context?.canRefreshConsent && !!context.consent && !consented}
            className="mt-4 min-h-11 w-full rounded-xl bg-[var(--salon-primary)] px-4 py-3 text-sm font-semibold text-[var(--booking-bg)] disabled:opacity-50">
            {context?.canRefreshConsent && context.consent ? copy.refreshConsent : copy.retry}
          </Button>
        ) : null}
      <a className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-[var(--salon-primary)] underline"
        href={`/booking/save-card?token=${encodeURIComponent(token)}`} referrerPolicy="no-referrer">{copy.link}</a>
    </section>
  );
}
