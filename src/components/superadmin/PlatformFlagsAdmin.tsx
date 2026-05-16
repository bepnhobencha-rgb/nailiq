"use client";

import { useState, useTransition } from "react";
import { cn } from "@/shared/lib/cn";
import { updatePlatformFlag } from "@/shared/superadmin/superadminActions";
import {
  PLATFORM_FLAG_DESCRIPTORS,
  type PlatformFlag,
  type PlatformFlagBadge,
  type PlatformFlagDescriptor,
} from "@/shared/superadmin/superadminTypes";

/**
 * Phase 1F — platform-wide feature flags admin.
 *
 * Extracted from `SuperAdminPanel.GlobalFlagsTab` (PR #108) so it
 * can live at the dedicated `/superadmin/operations/feature-flags`
 * route instead of inside the deprecated tabbed panel. Reads from
 * `platform_flags` via `loadPlatformFlags`, writes via
 * `updatePlatformFlag` — both already gated by `isSuperAdmin`.
 *
 * Toggling a `danger`-marked flag opens a confirmation prompt
 * (window.confirm — V1 friction, replace with a proper modal if
 * SOC2 audit demands UI-controlled gating).
 */

const PLATFORM_BADGE_CLASS: Record<PlatformFlagBadge, string> = {
  danger: "border-nq-error/55 bg-nq-error/15 text-nq-error",
  billing: "border-amber-500/55 bg-amber-400/15 text-amber-700",
  sms: "border-sky-500/55 bg-sky-400/15 text-sky-700",
  email: "border-purple-500/55 bg-purple-400/15 text-purple-700",
  registration:
    "border-emerald-500/55 bg-emerald-400/15 text-emerald-700",
};

const PLATFORM_BADGE_LABEL: Record<PlatformFlagBadge, string> = {
  danger: "⚠️ DANGER",
  billing: "💰 BILLING",
  sms: "📱 SMS",
  email: "📧 EMAIL",
  registration: "🔓 REGISTRATION",
};

export function PlatformFlagsAdmin({
  initialFlags,
  loadError,
}: {
  initialFlags: PlatformFlag[];
  loadError: string | null;
}) {
  if (loadError) {
    return (
      <p
        role="alert"
        className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
      >
        Failed to load platform flags ({loadError}). Apply the
        platform_flags migration before the panel will render.
      </p>
    );
  }

  return (
    <section
      data-testid="superadmin-platform-flags"
      className="flex flex-col gap-3"
    >
      <p className="text-sm text-nq-muted">
        These flags affect <strong>every salon</strong> on the platform.
        Toggling saves immediately. Dangerous flags ask for confirmation.
      </p>
      <ul className="flex flex-col gap-3">
        {PLATFORM_FLAG_DESCRIPTORS.map((descriptor) => {
          const initial = initialFlags.find((f) => f.key === descriptor.key);
          return (
            <li key={descriptor.key}>
              <PlatformFlagRow
                descriptor={descriptor}
                initialEnabled={initial?.enabled === true}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PlatformFlagRow({
  descriptor,
  initialEnabled,
}: {
  descriptor: PlatformFlagDescriptor;
  initialEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const onToggle = (next: boolean) => {
    if (descriptor.danger && next) {
      const confirmed = window.confirm(
        `Enable "${descriptor.label}"?\n\nThis is a DANGEROUS flag. Make sure this is the right environment.`,
      );
      if (!confirmed) return;
    }
    const prev = enabled;
    setEnabled(next);
    setError(null);
    startTransition(() => {
      void (async () => {
        const r = await updatePlatformFlag(descriptor.key, next);
        if (!r.ok) {
          setEnabled(prev);
          setError(r.error);
          return;
        }
        setSavedAt(Date.now());
      })();
    });
  };

  return (
    <article
      data-testid={`platform-flag-${descriptor.key}`}
      className={cn(
        "flex items-start gap-4 rounded-2xl border bg-nq-surface/40 p-4",
        descriptor.danger ? "border-nq-error/45" : "border-nq-border/40",
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={pending}
        onClick={() => onToggle(!enabled)}
        data-testid={`platform-flag-toggle-${descriptor.key}`}
        className={cn(
          "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors",
          enabled ? "bg-nq-primary" : "bg-nq-muted/40",
          pending && "opacity-60",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "inline-block h-5 w-5 transform rounded-full bg-white transition-transform",
            enabled ? "translate-x-6" : "translate-x-1",
          )}
        />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-nq-muted">
            {descriptor.key}
          </span>
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
              PLATFORM_BADGE_CLASS[descriptor.badge],
            )}
          >
            {PLATFORM_BADGE_LABEL[descriptor.badge]}
          </span>
        </div>
        <p className="mt-1 text-sm font-semibold text-nq-foreground">
          {descriptor.label}
        </p>
        <p className="mt-0.5 text-xs text-nq-muted">{descriptor.description}</p>
        <div className="mt-2 min-h-4 text-[11px]">
          {error ? (
            <span className="text-nq-error">Save failed: {error}</span>
          ) : savedAt && Date.now() - savedAt < 2400 ? (
            <span className="text-nq-success">Saved ✓</span>
          ) : null}
        </div>
      </div>
    </article>
  );
}
