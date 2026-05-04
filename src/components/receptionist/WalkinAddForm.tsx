"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/Button";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { cn } from "@/shared/lib/cn";
import { isValidCustomerName } from "@/shared/lib/nameFormat";

export interface WalkinAddFormProps {
  services: Array<{
    id: string;
    name: string;
    duration_minutes: number;
    price_cents: number;
  }>;
  /** Salon setup incomplete — block walk-in intake until catalog is ready */
  disabled?: boolean;
  /** Localized strings */
  labels: {
    namePlaceholder: string;
    phonePlaceholder: string;
    notePlaceholder: string;
    addButton: string;
    moreServices: string;
    submitting: string;
    errorRequired: string;
    invalidPhone: string;
    phoneRequired: string;
    invalidName: string;
    invalidNameChars: string;
  };
  /** Async callback — parent calls server action */
  onSubmit: (input: {
    clientName: string;
    clientPhone: string;
    serviceId: string;
    staffRequestNote: string | null;
  }) => Promise<{ ok: boolean; error?: string }>;
}

function formatServicePrice(priceCents: number): string {
  return `$${(priceCents / 100).toFixed(2)}`;
}

const TOP_SERVICE_COUNT = 6;

export function WalkinAddForm({
  services,
  labels,
  onSubmit,
  disabled = false,
}: WalkinAddFormProps) {
  const nameId = useId();
  const phoneId = useId();
  const noteId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [staffRequestNote, setStaffRequestNote] = useState("");
  const [showMoreServices, setShowMoreServices] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const formLocked = disabled || submitting;

  const topServices = useMemo(() => services.slice(0, TOP_SERVICE_COUNT), [services]);
  const extraServices = useMemo(() => services.slice(TOP_SERVICE_COUNT), [services]);

  const resetAfterSuccess = useCallback(() => {
    setClientName("");
    setClientPhone("");
    setSelectedServiceId(null);
    setStaffRequestNote("");
    setShowMoreServices(false);
    setErrorMessage(null);
    setNameError(null);
    setPhoneError(null);
    queueMicrotask(() => nameRef.current?.focus());
  }, []);

  const runSubmit = useCallback(async () => {
    if (disabled) return;
    const trimmedName = clientName.trim();
    if (trimmedName.length === 0 || trimmedName.length > BOOKING_GUEST_NAME_MAX) {
      setNameError(labels.invalidName);
      return;
    }
    if (!isValidCustomerName(trimmedName)) {
      setNameError(labels.invalidNameChars);
      return;
    }
    const trimmedPhone = clientPhone.trim();
    if (trimmedPhone.length === 0) {
      setPhoneError(labels.phoneRequired);
      return;
    }
    if (!validateGuestPhone(trimmedPhone).ok) {
      setPhoneError(labels.invalidPhone);
      return;
    }
    if (selectedServiceId === null) {
      setErrorMessage(labels.errorRequired);
      return;
    }

    setErrorMessage(null);
    setNameError(null);
    setPhoneError(null);

    setSubmitting(true);
    try {
      const result = await onSubmit({
        clientName: trimmedName,
        clientPhone: trimmedPhone,
        serviceId: selectedServiceId,
        staffRequestNote: staffRequestNote.trim().length ? staffRequestNote.trim() : null,
      });

      if (result.ok) {
        resetAfterSuccess();
      } else {
        setErrorMessage(result.error ?? labels.errorRequired);
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    clientName,
    clientPhone,
    labels.errorRequired,
    labels.invalidName,
    labels.invalidNameChars,
    labels.invalidPhone,
    labels.phoneRequired,
    onSubmit,
    resetAfterSuccess,
    selectedServiceId,
    staffRequestNote,
    disabled,
  ]);

  useEffect(() => {
    if (!disabled) nameRef.current?.focus();
  }, [disabled]);

  const onNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (clientPhone.trim().length === 0) {
        document.getElementById(`walkin-service-${topServices[0]?.id ?? ""}`)?.focus();
      } else {
        phoneRef.current?.focus();
      }
    }
  };

  const onPhoneKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById(`walkin-service-${topServices[0]?.id ?? ""}`)?.focus();
    }
  };

  const onNoteKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void runSubmit();
    }
    if (e.key === "Escape") {
      setErrorMessage(null);
      setNameError(null);
      setPhoneError(null);
    }
  };

  const onFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Escape") {
      setErrorMessage(null);
      setNameError(null);
      setPhoneError(null);
    }
  };

  return (
    <form
      data-testid="walkin-add-form"
      className={cn(
        "space-y-3 border-b border-nq-muted/20 pb-4",
        disabled && "opacity-55",
      )}
      onSubmit={(e) => {
        e.preventDefault();
        void runSubmit();
      }}
      onKeyDown={onFormKeyDown}
    >
      <div className="space-y-2">
        <label htmlFor={nameId} className="sr-only">
          {labels.namePlaceholder}
        </label>
        <input
          id={nameId}
          ref={nameRef}
          type="text"
          data-testid="walkin-name"
          autoComplete="name"
          disabled={formLocked}
          placeholder={labels.namePlaceholder}
          value={clientName}
          maxLength={BOOKING_GUEST_NAME_MAX}
          onChange={(e) => {
            setClientName(e.target.value);
            setNameError(null);
          }}
          onBlur={() => {
            const t = clientName.trim();
            setClientName(t);
            if (t.length === 0 || t.length > BOOKING_GUEST_NAME_MAX) {
              setNameError(labels.invalidName);
            } else if (!isValidCustomerName(t)) {
              setNameError(labels.invalidNameChars);
            } else {
              setNameError(null);
            }
          }}
          onKeyDown={onNameKeyDown}
          aria-invalid={Boolean(nameError)}
          className={cn(
            "h-11 w-full rounded-lg border bg-nq-bg px-3 text-base text-nq-foreground placeholder:text-nq-muted focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
            nameError ? "border-nq-error/50 focus:border-nq-error/60" : "border-nq-muted/35 focus:border-nq-primary",
            formLocked && "opacity-60",
          )}
        />
        {nameError ? (
          <p className="text-xs text-nq-error" role="alert" data-testid="walkin-name-error">
            {nameError}
          </p>
        ) : null}
        <label htmlFor={phoneId} className="sr-only">
          {labels.phonePlaceholder}
        </label>
        <input
          id={phoneId}
          ref={phoneRef}
          type="tel"
          autoComplete="tel"
          disabled={formLocked}
          placeholder={labels.phonePlaceholder}
          value={clientPhone}
          maxLength={24}
          onChange={(e) => {
            setClientPhone(e.target.value);
            setPhoneError(null);
          }}
          onBlur={() => {
            const p = clientPhone.trim();
            setClientPhone(p);
            if (p.length === 0) {
              setPhoneError(null);
              return;
            }
            setPhoneError(validateGuestPhone(p).ok ? null : labels.invalidPhone);
          }}
          onKeyDown={onPhoneKeyDown}
          aria-invalid={Boolean(phoneError)}
          data-testid="walkin-phone"
          className={cn(
            "h-11 w-full rounded-lg border bg-nq-bg px-3 text-base text-nq-foreground placeholder:text-nq-muted focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
            phoneError ? "border-nq-error/50 focus:border-nq-error/60" : "border-nq-muted/35 focus:border-nq-primary",
            formLocked && "opacity-60",
          )}
        />
        {phoneError ? (
          <p className="text-xs text-nq-error" role="alert" data-testid="walkin-phone-error">
            {phoneError}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {topServices.map((s) => {
            const selected = selectedServiceId === s.id;
            return (
              <button
                key={s.id}
                id={`walkin-service-${s.id}`}
                type="button"
                disabled={formLocked}
                onClick={() => setSelectedServiceId(s.id)}
                className={cn(
                  "flex min-h-16 flex-col items-start justify-center rounded-lg border px-2.5 py-2 text-left text-sm transition-[border-color,background-color] duration-[var(--duration-nq-fast,150ms)]",
                  selected
                    ? "border-nq-primary bg-nq-primary/12 text-nq-foreground"
                    : "border-nq-muted/35 bg-nq-surface text-nq-foreground hover:border-nq-muted",
                  formLocked && "opacity-60",
                )}
              >
                <span className="line-clamp-2 font-semibold leading-snug">{s.name}</span>
                <span className="mt-0.5 font-mono text-[11px] text-nq-muted">
                  {s.duration_minutes}m · {formatServicePrice(s.price_cents)}
                </span>
              </button>
            );
          })}
        </div>
        {extraServices.length > 0 && (
          <>
            <button
              type="button"
              disabled={formLocked}
              onClick={() => setShowMoreServices((v) => !v)}
              className={cn(
                "text-sm font-medium text-nq-primary hover:text-nq-primary/90",
                formLocked && "pointer-events-none opacity-60",
              )}
            >
              {labels.moreServices}
            </button>
            {showMoreServices && (
              <ul
                className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-nq-muted/25 bg-nq-bg p-1"
                role="listbox"
              >
                {extraServices.map((s) => {
                  const selected = selectedServiceId === s.id;
                  return (
                    <li key={s.id} role="none">
                      <button
                        type="button"
                        disabled={formLocked}
                        onClick={() => setSelectedServiceId(s.id)}
                        className={cn(
                          "flex w-full flex-col items-start rounded-md px-2 py-2 text-left text-sm",
                          selected
                            ? "bg-nq-primary/15 text-nq-primary"
                            : "text-nq-foreground hover:bg-nq-muted/15",
                        )}
                      >
                        <span className="font-medium">{s.name}</span>
                        <span className="font-mono text-[11px] text-nq-muted">
                          {s.duration_minutes}m · {formatServicePrice(s.price_cents)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>

      <div>
        <label htmlFor={noteId} className="sr-only">
          {labels.notePlaceholder}
        </label>
        <textarea
          id={noteId}
          disabled={formLocked}
          placeholder={labels.notePlaceholder}
          value={staffRequestNote}
          onChange={(e) => setStaffRequestNote(e.target.value)}
          onKeyDown={onNoteKeyDown}
          rows={2}
          className={cn(
            "w-full resize-none rounded-lg border border-nq-muted/35 bg-nq-bg px-3 py-2 text-base text-nq-foreground placeholder:text-nq-muted focus:border-nq-primary focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
            formLocked && "opacity-60",
          )}
        />
      </div>

      {errorMessage ? (
        <p className="text-sm text-nq-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <Button
        type="submit"
        variant="primary"
        loading={submitting}
        disabled={disabled || submitting || !!nameError || !!phoneError}
        className="w-full sm:w-full"
      >
        {submitting ? labels.submitting : labels.addButton}
      </Button>
    </form>
  );
}
