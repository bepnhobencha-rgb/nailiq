"use client";

import {
  useCallback,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/Button";
import { addSalonEmail } from "@/shared/dashboard/addEmailAction";
import { getUserMessages } from "@/shared/i18n/user";
import type { UserLanguage } from "@/shared/i18n/user/types";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";

const STORAGE_KEY = "nailiq-email-banner-dismissed";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function readDismissedWithinWeek(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const ms = Number.parseInt(raw, 10);
    if (!Number.isFinite(ms)) return false;
    return Date.now() - ms < SEVEN_DAYS_MS;
  } catch {
    return false;
  }
}

function writeDismissNow(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    /* ignore quota / privacy */
  }
}

const noopSubscribe = () => () => {};

function useDismissedWithinWeekHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    readDismissedWithinWeek,
    () => false,
  );
}

type Props = {
  salonSlug: string;
  language: UserLanguage;
  onDismiss: () => void;
  onEmailAdded: (email: string) => void;
};

export function AddEmailBanner({
  salonSlug,
  language,
  onDismiss,
  onEmailAdded,
}: Props) {
  const t = getUserMessages(language).ownerDashboard.addEmailBanner;
  const formId = useId();
  const dismissedFromStorage = useDismissedWithinWeekHydrated();
  const [sessionDismissed, setSessionDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [savedState, setSavedState] = useState(false);
  const [confirmedEmail, setConfirmedEmail] = useState<string | null>(null);

  const dismissed = dismissedFromStorage || sessionDismissed;

  const handleDismiss = useCallback(() => {
    writeDismissNow();
    setSessionDismissed(true);
    onDismiss();
  }, [onDismiss]);

  const finishSuccess = useCallback(
    (email: string) => {
      setSavedState(false);
      setConfirmedEmail(null);
      onEmailAdded(email);
    },
    [onEmailAdded],
  );

  useEffect(() => {
    if (!savedState || !confirmedEmail) return;
    const saved = confirmedEmail;
    const t = window.setTimeout(() => {
      finishSuccess(saved);
    }, 3000);
    return () => window.clearTimeout(t);
  }, [savedState, confirmedEmail, finishSuccess]);

  const handleSubmit = useCallback(async () => {
    const trimmed = emailInput.trim();
    setSubmitError(null);
    if (!isValidEmailFormat(trimmed)) {
      setFieldError(t.emailInvalid);
      return;
    }
    setFieldError(null);
    setPending(true);
    const res = await addSalonEmail(salonSlug, trimmed);
    setPending(false);
    if (!res.ok) {
      if (res.error === "invalid_email") {
        setFieldError(t.emailInvalid);
        return;
      }
      setSubmitError(t.saveFailed);
      return;
    }
    setConfirmedEmail(trimmed);
    setSavedState(true);
  }, [emailInput, salonSlug]);

  if (savedState && confirmedEmail) {
    return (
      <div className="nq-email-banner-enter mb-4 w-full rounded-2xl border border-nq-success/35 bg-nq-success/12 px-4 py-3">
        <p className="text-center text-[15px] font-medium leading-snug text-nq-foreground">
          {t.successMessage}
        </p>
      </div>
    );
  }

  if (dismissed) return null;

  return (
    <div
      id="email"
      className="nq-email-banner-enter mb-4 w-full rounded-2xl border bg-nq-primary/12 px-4 py-3"
      style={{ borderColor: "var(--nq-border-gold-banner)" }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-start gap-2 text-[15px] font-medium leading-snug text-nq-foreground">
            <span aria-hidden className="shrink-0">
              🔐
            </span>
            <span>{t.headline}</span>
          </p>
          <p className="mt-1.5 pl-7 text-sm leading-snug text-nq-muted">
            {t.socialProof}
          </p>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-2 sm:max-w-[min(100%,16rem)] sm:flex-shrink-0 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="w-full whitespace-nowrap sm:w-auto sm:min-w-[9rem]"
            onClick={() => {
              setExpanded((e) => !e);
            }}
          >
            {t.ctaAdd}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full whitespace-nowrap sm:w-auto sm:min-w-[9rem]"
            disabled={pending}
            onClick={handleDismiss}
          >
            {t.ctaLater}
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="mt-4 flex flex-col gap-2 border-t border-nq-border/30 pt-4">
          <label htmlFor={formId} className="sr-only">
            {t.emailPlaceholder}
          </label>
          <input
            id={formId}
            name="recovery-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder={t.emailPlaceholder}
            value={emailInput}
            disabled={pending}
            onChange={(e) => {
              setEmailInput(e.target.value);
              setFieldError(null);
              setSubmitError(null);
            }}
            className="w-full rounded-xl border border-nq-border/50 bg-nq-bg/85 px-3.5 py-2.5 text-base text-nq-foreground shadow-nq-sm outline-none placeholder:text-nq-muted/90 focus-visible:border-nq-primary/80 focus-visible:shadow-nq-input-focus disabled:opacity-70"
          />
          {fieldError ? (
            <p className="text-sm text-nq-error" role="alert">
              {fieldError}
            </p>
          ) : null}
          {submitError ? (
            <p className="text-sm text-nq-error" role="alert">
              {submitError}
            </p>
          ) : null}
          <Button
            type="button"
            variant="primary"
            size="lg"
            className="w-full min-h-11 min-w-0 touch-manipulation disabled:touch-auto"
            disabled={pending || !emailInput.trim()}
            onClick={() => {
              void handleSubmit();
            }}
          >
            {pending ? t.savingButton : t.saveButton}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
