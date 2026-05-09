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
import {
  QUEUE_PRIORITIES,
  QUEUE_REQUEST_TAG_MAX_LEN,
  QUEUE_REQUEST_TAGS_MAX_COUNT,
  QUEUE_SOURCES,
  type QueuePriority,
  type QueueRequestTag,
  type QueueSource,
} from "@/shared/types";

export interface WalkinAddFormProps {
  services: Array<{
    id: string;
    name: string;
    duration_minutes: number;
    price_cents: number;
  }>;
  /** Salon setup incomplete — block walk-in intake until catalog is ready */
  disabled?: boolean;
  /**
   * Realtime offline guard. When true, the submit button is locked
   * and an inline offline-specific hint is rendered above it. Mutation
   * guard for the `ConnectionBanner` state — prevents writes against
   * stale data when the realtime channel is erroring/closed.
   */
  isOffline?: boolean;
  /** Localized hint shown when `isOffline` is true. */
  offlineDisabledHint?: string;
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
    nameRequired: string;
    nameTooLong: string;
    invalidNameChars: string;
    sourceLabel: string;
    sourceOptions: Record<QueueSource, string>;
    priorityLabel: string;
    priorityOptions: Record<QueuePriority, string>;
    requestTagsLabel: string;
    requestTagsPlaceholder: string;
    requestTagAdd: string;
    requestTagRemove: (label: string) => string;
  };
  /** Async callback — parent calls server action */
  onSubmit: (input: {
    clientName: string;
    clientPhone: string;
    serviceId: string;
    staffRequestNote: string | null;
    walkinSource: QueueSource | null;
    walkinPriority: QueuePriority | null;
    walkinRequestTags: QueueRequestTag[];
  }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Popular service ids derived from today's bookings (server-side).
   * Rendered as shortcut chips above the service grid; tapping a chip
   * snaps `selectedServiceId` to that id. Hidden when undefined or
   * empty.
   */
  popularServiceIds?: ReadonlyArray<string>;
  /** Localized label for the popular chip row. */
  popularServicesLabel?: string;
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
  isOffline = false,
  offlineDisabledHint,
  popularServiceIds,
  popularServicesLabel,
}: WalkinAddFormProps) {
  const nameId = useId();
  const phoneId = useId();
  const noteId = useId();
  const sourceId = useId();
  const priorityId = useId();
  const tagInputId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(
    null,
  );
  const [staffRequestNote, setStaffRequestNote] = useState("");
  const [showMoreServices, setShowMoreServices] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [walkinSource, setWalkinSource] = useState<QueueSource | "">("");
  const [walkinPriority, setWalkinPriority] = useState<QueuePriority | "">("");
  const [requestTags, setRequestTags] = useState<QueueRequestTag[]>([]);
  const [tagDraft, setTagDraft] = useState("");

  // Offline locks every interactive control except read-only fields,
  // matching the existing `disabled` semantic; the inline hint below
  // the submit gives the receptionist offline-specific copy so they
  // know it's a connection issue rather than a setup state.
  const formLocked = disabled || submitting || isOffline;

  const topServices = useMemo(
    () => services.slice(0, TOP_SERVICE_COUNT),
    [services],
  );
  const extraServices = useMemo(
    () => services.slice(TOP_SERVICE_COUNT),
    [services],
  );

  // Resolve popular ids → catalog rows in the order supplied (which is
  // the server-side frequency rank). Drops ids that no longer exist in
  // the catalog (e.g. a service the owner just deleted between loads).
  const popularServices = useMemo(() => {
    if (!popularServiceIds || popularServiceIds.length === 0) return [];
    const byId = new Map(services.map((s) => [s.id, s] as const));
    const out: typeof services = [];
    for (const id of popularServiceIds) {
      const row = byId.get(id);
      if (row) out.push(row);
    }
    return out;
  }, [popularServiceIds, services]);

  const resetAfterSuccess = useCallback(() => {
    setClientName("");
    setClientPhone("");
    setSelectedServiceId(null);
    setStaffRequestNote("");
    setShowMoreServices(false);
    setErrorMessage(null);
    setNameError(null);
    setPhoneError(null);
    setWalkinSource("");
    setWalkinPriority("");
    setRequestTags([]);
    setTagDraft("");
    queueMicrotask(() => nameRef.current?.focus());
  }, []);

  const addTag = useCallback(() => {
    const t = tagDraft.trim();
    if (t.length === 0) return;
    if (t.length > QUEUE_REQUEST_TAG_MAX_LEN) return;
    setRequestTags((prev) => {
      if (prev.length >= QUEUE_REQUEST_TAGS_MAX_COUNT) return prev;
      if (prev.includes(t)) return prev;
      return [...prev, t];
    });
    setTagDraft("");
  }, [tagDraft]);

  const removeTag = useCallback((tag: QueueRequestTag) => {
    setRequestTags((prev) => prev.filter((t) => t !== tag));
  }, []);

  const runSubmit = useCallback(async () => {
    if (disabled) return;
    const trimmedName = clientName.trim();
    if (trimmedName.length === 0) {
      setNameError(labels.nameRequired);
      return;
    }
    if (trimmedName.length > BOOKING_GUEST_NAME_MAX) {
      setNameError(labels.nameTooLong);
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
        staffRequestNote: staffRequestNote.trim().length
          ? staffRequestNote.trim()
          : null,
        walkinSource: walkinSource === "" ? null : walkinSource,
        walkinPriority: walkinPriority === "" ? null : walkinPriority,
        walkinRequestTags: requestTags,
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
    labels.nameRequired,
    labels.nameTooLong,
    labels.invalidNameChars,
    labels.invalidPhone,
    labels.phoneRequired,
    onSubmit,
    resetAfterSuccess,
    selectedServiceId,
    staffRequestNote,
    walkinSource,
    walkinPriority,
    requestTags,
    disabled,
  ]);

  useEffect(() => {
    if (!disabled) nameRef.current?.focus();
  }, [disabled]);

  const onNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (clientPhone.trim().length === 0) {
        document
          .getElementById(`walkin-service-${topServices[0]?.id ?? ""}`)
          ?.focus();
      } else {
        phoneRef.current?.focus();
      }
    }
  };

  const onPhoneKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document
        .getElementById(`walkin-service-${topServices[0]?.id ?? ""}`)
        ?.focus();
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

  const onTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag();
    }
  };

  const onPriorityKeyDown = (e: React.KeyboardEvent<HTMLSelectElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitRef.current?.focus();
      void runSubmit();
    }
  };

  const onFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Escape") {
      setErrorMessage(null);
      setNameError(null);
      setPhoneError(null);
    }
    // Cmd/Ctrl + Enter from any field submits the form. Reception speed
    // path: the form's other key handlers advance field-by-field; this
    // shortcut bypasses the chain when the receptionist already knows
    // every field is filled (the existing per-field validators still
    // run inside `runSubmit`, so missing required values still surface).
    if (
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey) &&
      !formLocked
    ) {
      e.preventDefault();
      void runSubmit();
    }
  };

  const tagsAtCap = requestTags.length >= QUEUE_REQUEST_TAGS_MAX_COUNT;

  return (
    <form
      data-testid="walkin-add-form"
      method="post"
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
            if (t.length === 0) {
              setNameError(labels.nameRequired);
            } else if (t.length > BOOKING_GUEST_NAME_MAX) {
              setNameError(labels.nameTooLong);
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
            nameError
              ? "border-nq-error/50 focus:border-nq-error/60"
              : "border-nq-muted/35 focus:border-nq-primary",
            formLocked && "opacity-60",
          )}
        />
        {nameError ? (
          <p
            className="text-xs text-nq-error"
            role="alert"
            data-testid="walkin-name-error"
          >
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
            setPhoneError(
              validateGuestPhone(p).ok ? null : labels.invalidPhone,
            );
          }}
          onKeyDown={onPhoneKeyDown}
          aria-invalid={Boolean(phoneError)}
          data-testid="walkin-phone"
          className={cn(
            "h-11 w-full rounded-lg border bg-nq-bg px-3 text-base text-nq-foreground placeholder:text-nq-muted focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
            phoneError
              ? "border-nq-error/50 focus:border-nq-error/60"
              : "border-nq-muted/35 focus:border-nq-primary",
            formLocked && "opacity-60",
          )}
        />
        {phoneError ? (
          <p
            className="text-xs text-nq-error"
            role="alert"
            data-testid="walkin-phone-error"
          >
            {phoneError}
          </p>
        ) : null}
      </div>

      {popularServices.length > 0 ? (
        <div
          data-testid="walkin-popular-services"
          className="space-y-1"
        >
          {popularServicesLabel ? (
            <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
              {popularServicesLabel}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {popularServices.map((s) => {
              const selected = selectedServiceId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  data-testid={`walkin-popular-${s.id}`}
                  disabled={formLocked}
                  onClick={() => setSelectedServiceId(s.id)}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    selected
                      ? "border-nq-primary bg-nq-primary/15 text-nq-primary"
                      : "border-nq-border bg-nq-surface/60 text-nq-foreground hover:border-nq-primary/40",
                    formLocked && "opacity-60",
                  )}
                >
                  <span aria-hidden>★</span>
                  <span className="truncate">{s.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

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
                <span className="line-clamp-2 font-semibold leading-snug">
                  {s.name}
                </span>
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
                          {s.duration_minutes}m ·{" "}
                          {formatServicePrice(s.price_cents)}
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

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label
            htmlFor={sourceId}
            className="mb-1 block text-xs font-medium text-nq-muted"
          >
            {labels.sourceLabel}
          </label>
          <select
            id={sourceId}
            data-testid="walkin-source"
            disabled={formLocked}
            value={walkinSource}
            onChange={(e) =>
              setWalkinSource((e.target.value || "") as QueueSource | "")
            }
            className={cn(
              "h-10 w-full rounded-lg border border-nq-muted/35 bg-nq-bg px-2 text-sm text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
              formLocked && "opacity-60",
            )}
          >
            <option value="">—</option>
            {QUEUE_SOURCES.map((src) => (
              <option key={src} value={src}>
                {labels.sourceOptions[src]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor={priorityId}
            className="mb-1 block text-xs font-medium text-nq-muted"
          >
            {labels.priorityLabel}
          </label>
          <select
            id={priorityId}
            data-testid="walkin-priority"
            disabled={formLocked}
            value={walkinPriority}
            onChange={(e) =>
              setWalkinPriority(
                (e.target.value || "") as QueuePriority | "",
              )
            }
            onKeyDown={onPriorityKeyDown}
            className={cn(
              "h-10 w-full rounded-lg border border-nq-muted/35 bg-nq-bg px-2 text-sm text-nq-foreground focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
              formLocked && "opacity-60",
            )}
          >
            <option value="">—</option>
            {QUEUE_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {labels.priorityOptions[p]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label
          htmlFor={tagInputId}
          className="mb-1 block text-xs font-medium text-nq-muted"
        >
          {labels.requestTagsLabel}
        </label>
        <div className="flex gap-2">
          <input
            id={tagInputId}
            data-testid="walkin-request-tag-input"
            type="text"
            disabled={formLocked || tagsAtCap}
            placeholder={labels.requestTagsPlaceholder}
            value={tagDraft}
            maxLength={QUEUE_REQUEST_TAG_MAX_LEN}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={onTagInputKeyDown}
            className={cn(
              "h-10 flex-1 rounded-lg border border-nq-muted/35 bg-nq-bg px-3 text-sm text-nq-foreground placeholder:text-nq-muted focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
              (formLocked || tagsAtCap) && "opacity-60",
            )}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={
              formLocked || tagsAtCap || tagDraft.trim().length === 0
            }
            onClick={addTag}
          >
            {labels.requestTagAdd}
          </Button>
        </div>
        {requestTags.length > 0 ? (
          <ul
            className="mt-2 flex flex-wrap gap-1.5"
            data-testid="walkin-request-tags-list"
            aria-label={labels.requestTagsLabel}
          >
            {requestTags.map((tag) => (
              <li key={tag}>
                <button
                  type="button"
                  data-testid={`walkin-request-tag-remove-${tag}`}
                  disabled={formLocked}
                  onClick={() => removeTag(tag)}
                  aria-label={labels.requestTagRemove(tag)}
                  className="inline-flex items-center gap-1 rounded-full border border-nq-border bg-nq-surface/60 px-2 py-0.5 text-xs text-nq-foreground hover:border-nq-primary/40"
                >
                  <span>{tag}</span>
                  <span aria-hidden>×</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
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

      {isOffline && offlineDisabledHint ? (
        <p
          className="text-xs font-semibold text-nq-error"
          role="status"
          data-testid="walkin-offline-hint"
        >
          {offlineDisabledHint}
        </p>
      ) : null}

      <Button
        ref={submitRef}
        type="submit"
        variant="primary"
        loading={submitting}
        disabled={
          disabled ||
          submitting ||
          isOffline ||
          !!nameError ||
          !!phoneError
        }
        title={isOffline ? offlineDisabledHint : undefined}
        className="w-full sm:w-full"
      >
        {submitting ? labels.submitting : labels.addButton}
      </Button>
    </form>
  );
}
