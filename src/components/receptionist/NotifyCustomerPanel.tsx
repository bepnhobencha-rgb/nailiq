"use client";

import { cn } from "@/shared/lib/cn";

/**
 * "Notify the customer?" panel shown when staff create / reschedule / cancel a
 * booking. Channel toggles (SMS / Email — each auto-disabled when the customer
 * has no phone / email on file) plus a live preview of the exact message that
 * will be sent, in the resolved language. Purely presentational + controlled.
 */

export interface NotifyChannels {
  sms: boolean;
  email: boolean;
}

export interface NotifyCustomerPanelLabels {
  heading: string;
  sms: string;
  email: string;
  previewTitle: string;
  /** Shown (muted) when both channels are off → nothing will be sent. */
  willNotNotify: string;
  /** e.g. "English" / "Tiếng Việt" — which language the message goes out in. */
  languageNote: string;
  /** Tooltip/subtext when a channel is unavailable (no contact on file). */
  noPhone: string;
  noEmail: string;
}

export interface NotifyCustomerPanelProps {
  value: NotifyChannels;
  onChange: (next: NotifyChannels) => void;
  hasPhone: boolean;
  hasEmail: boolean;
  /** Exact message body that will be sent, already built in the target locale.
   *  Null hides the preview (e.g. no_show). */
  previewText: string | null;
  labels: NotifyCustomerPanelLabels;
}

function ToggleChip({
  on,
  disabled,
  label,
  sublabel,
  onClick,
  testId,
}: {
  on: boolean;
  disabled: boolean;
  label: string;
  sublabel?: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on && !disabled}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors",
        disabled
          ? "cursor-not-allowed border-nq-muted/15 bg-nq-muted/5 text-nq-muted/50"
          : on
            ? "border-nq-primary/60 bg-nq-primary/15 text-nq-foreground"
            : "border-nq-muted/25 bg-nq-bg text-nq-muted hover:border-nq-muted/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded border text-[10px] leading-none",
          on && !disabled
            ? "border-nq-primary bg-nq-primary text-white"
            : "border-nq-muted/40 text-transparent",
        )}
      >
        ✓
      </span>
      <span className="flex flex-col items-start leading-tight">
        <span>{label}</span>
        {disabled && sublabel ? (
          <span className="text-[10px] font-normal text-nq-muted/60">{sublabel}</span>
        ) : null}
      </span>
    </button>
  );
}

export function NotifyCustomerPanel({
  value,
  onChange,
  hasPhone,
  hasEmail,
  previewText,
  labels,
}: NotifyCustomerPanelProps) {
  const smsOn = value.sms && hasPhone;
  const emailOn = value.email && hasEmail;
  const nothingOn = !smsOn && !emailOn;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-nq-muted/15 bg-nq-surface/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
          {labels.heading}
        </span>
        <span className="text-[10px] font-medium text-nq-muted/70">
          {labels.languageNote}
        </span>
      </div>

      <div className="flex gap-2">
        <ToggleChip
          testId="notify-toggle-sms"
          on={value.sms}
          disabled={!hasPhone}
          label={labels.sms}
          sublabel={labels.noPhone}
          onClick={() => onChange({ ...value, sms: !value.sms })}
        />
        <ToggleChip
          testId="notify-toggle-email"
          on={value.email}
          disabled={!hasEmail}
          label={labels.email}
          sublabel={labels.noEmail}
          onClick={() => onChange({ ...value, email: !value.email })}
        />
      </div>

      {!nothingOn && previewText ? (
        <div className="rounded-lg bg-nq-bg/70 p-2.5" data-testid="notify-preview">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-nq-muted/70">
            {labels.previewTitle}
          </div>
          <p className="whitespace-pre-wrap text-xs leading-snug text-nq-foreground/90">
            {previewText}
          </p>
        </div>
      ) : null}

      {nothingOn ? (
        <p className="text-[11px] font-medium text-nq-muted/70" data-testid="notify-none">
          {labels.willNotNotify}
        </p>
      ) : null}
    </div>
  );
}
