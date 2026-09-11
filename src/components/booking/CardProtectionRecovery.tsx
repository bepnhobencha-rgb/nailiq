"use client";
import { Button } from "@/components/ui/Button";
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { isCardProtectionStatus, type CardProtectionStatus } from "@/shared/booking/cardProtection";
import { recoverBookingCardAction } from "@/shared/booking/recoverBookingCardAction";
import type { BookingMessages } from "@/shared/i18n/booking/en";

type Context = { protectionStatus: CardProtectionStatus; capturePaused: boolean; canRetry: boolean; cancelled: boolean; canRefreshConsent: boolean; canVerifyExistingCard: boolean; consent: { version: string; policyEn: string; policyVi: string } | null };
export function CardProtectionRecovery<P extends object>({ token, t, Capture, captureProps }: {
  token: string; t: BookingMessages; captureProps: P;
  Capture: ComponentType<P & { managementToken: string; onSettled: () => Promise<void> }>;
}) {
  const [context, setContext] = useState<Context | null>(null);
  const [consentKey, setConsentKey] = useState<string | null>(null);
  const currentConsentKey = `${token}:${context?.consent?.version ?? ""}`;
  const consented = consentKey === currentConsentKey;
  const [activeToken, setActiveToken] = useState<string | null>(null);
  const [error, setError] = useState<"unavailable" | "expired" | "verificationFailed" | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const copy = t.cardProtection;
  const load = useCallback((): Promise<CardProtectionStatus | undefined> => {
    const requestGeneration = ++generation.current;
    return fetch(`/api/booking/save-card-context?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (response) => {
        const value = await response.json();
        if (!mounted.current || requestGeneration !== generation.current) return;
        if (!response.ok || value.ok !== true || !isCardProtectionStatus(value.protectionStatus)) {
          setError(response.status === 400 || response.status === 404 ? "expired" : "unavailable"); setContext(null); return;
        }
        setContext({ protectionStatus:value.protectionStatus,capturePaused:value.capturePaused === true,canRetry:value.canRetry === true,cancelled:value.cancelled === true,
          canRefreshConsent:value.canRefreshConsent === true,canVerifyExistingCard:value.canVerifyExistingCard === true,consent:value.consent ?? null });
        setError(null);
        return value.protectionStatus;
      }).catch(() => {
        if (mounted.current && requestGeneration === generation.current) { setError("unavailable"); setContext(null); }
      });
  }, [token]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; generation.current += 1; };
  }, [load]);
  const needsConsent = context?.canRefreshConsent || context?.canVerifyExistingCard;
  const settled = useCallback(async () => { setActiveToken(null); await load(); }, [load]);
  async function retry() {
    if (pending.current || context?.capturePaused || context?.cancelled) return;
    pending.current = true; setBusy(true);
    try {
      const result = await recoverBookingCardAction(token, needsConsent && context?.consent && consented
        ? { accepted: true, policyVersion: context.consent.version } : undefined);
      const refreshedStatus = await load();
      if (mounted.current && result.ok && result.managementToken) setActiveToken(result.managementToken);
      if (mounted.current && !result.ok && refreshedStatus && refreshedStatus !== "saved") setError(context?.canVerifyExistingCard ? "verificationFailed" : "unavailable");
    } catch { if (mounted.current) setError("unavailable"); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const status = context?.protectionStatus;
  return (
    <section className="rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4 text-[var(--booking-text)]" data-testid="card-protection-recovery" data-protection-status={status ?? "unavailable"}>
      <div role="status" aria-live="polite">
        {context ? <p className="text-sm font-semibold">{context.cancelled ? copy.cancelled : status === "saved" ? copy.active : copy.reserved}</p> : null}
        <p className="mt-2 text-sm leading-6 text-[var(--booking-text-muted)]">
          {context?.cancelled ? copy.cancelledDetail : status === "saved" ? copy.noCharge : error ? copy[error] : !context ? copy.checking : status === "not_required" ? copy.notRequired : context.capturePaused ? copy.paused : context.canVerifyExistingCard ? copy.legacyPending : copy.pending}
        </p>
        {!context?.cancelled && !context?.capturePaused && status === "manual_review" && !context?.canVerifyExistingCard ? <p className="mt-2 text-sm">{copy.review}</p> : null}
        {!context?.cancelled && !context?.capturePaused && (status === "saving" || status === "reconciliation_pending") ? <p className="mt-2 text-sm">{copy.reconciling}</p> : null}
      </div>
      {needsConsent && context?.consent && !context.capturePaused && !context.cancelled ? <div className="mt-3">
        <details><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">{copy.policyLabel}</summary>
          <p className="whitespace-pre-wrap text-sm leading-6">{copy.policyLanguage === "vi" ? context.consent.policyVi : context.consent.policyEn}</p>
        </details>
        <label className="flex min-h-11 items-start gap-3 py-3 text-sm leading-6">
          <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={consented} onChange={(event) => setConsentKey(event.target.checked ? currentConsentKey : null)} />
          {copy.consentLabel}
        </label>
      </div> : null}
      {activeToken && context?.canRetry && !context.cancelled && !context.capturePaused ? <Capture {...captureProps} managementToken={activeToken} onSettled={settled} /> :
        (context || error === "unavailable") && status !== "saved" && status !== "not_required" && error !== "expired" && !context?.cancelled && !context?.capturePaused ? (
          <Button type="button" size="lg" fullWidth loading={busy} onClick={() => void retry()} disabled={!!needsConsent && (!context?.consent || !consented)}
            className="mt-4 min-h-11 w-full rounded-xl bg-[var(--salon-primary)] px-4 py-3 text-sm font-semibold text-[var(--booking-bg)] disabled:opacity-50">
            {context?.canVerifyExistingCard ? copy.verifyExisting : needsConsent && context?.consent ? copy.refreshConsent : copy.retry}
          </Button>
        ) : null}
      <a className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-[var(--salon-primary)] underline"
        href={`/booking/save-card?token=${encodeURIComponent(token)}`} referrerPolicy="no-referrer">{copy.link}</a>
    </section>
  );
}
