"use client";

import { useState, useTransition } from "react";
import { cn } from "@/shared/lib/cn";
import { updatePlatformFeatureFlag } from "@/shared/superadmin/superadminActions";
import {
  RELEASE_FEATURES,
  RELEASE_FEATURE_KEYS,
  type ReleaseFeatureKey,
} from "@/shared/features/featureRegistry";

/**
 * Platform-wide feature visibility (kill-switches). OFF here hides a feature
 * for EVERY salon, overriding per-salon settings. Distinct from the platform
 * INFRASTRUCTURE flags above (SMS/email/billing/OTP/registration).
 *
 * Per-salon control lives on each salon's detail page; this is the global
 * override layer.
 */
export function PlatformFeatureVisibilityAdmin({
  initialStates,
}: {
  initialStates: Record<ReleaseFeatureKey, boolean>;
}) {
  const [states, setStates] = useState(initialStates);
  const [pendingKey, setPendingKey] = useState<ReleaseFeatureKey | null>(null);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: ReleaseFeatureKey, next: boolean) => {
    if (
      !next &&
      typeof window !== "undefined" &&
      !window.confirm(
        `Turn OFF "${RELEASE_FEATURES[key].label}" for ALL salons? It will be hidden everywhere, regardless of each salon's own setting.`,
      )
    ) {
      return;
    }
    setError(null);
    setPendingKey(key);
    // Optimistic.
    setStates((prev) => ({ ...prev, [key]: next }));
    startTransition(async () => {
      const res = await updatePlatformFeatureFlag(key, next);
      if (!res.ok) {
        setStates((prev) => ({ ...prev, [key]: !next })); // rollback
        setError(res.error);
      }
      setPendingKey(null);
    });
  };

  return (
    <section
      data-testid="superadmin-platform-feature-visibility"
      className="flex flex-col gap-3"
    >
      <p className="text-sm text-nq-muted">
        Global kill-switches for product features. Turning one{" "}
        <strong>OFF hides it for every salon</strong> (overrides per-salon
        settings). Leave ON to let each salon&apos;s own setting decide. Manage
        a single salon from its detail page.
      </p>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-nq-error/40 bg-nq-error/10 px-3 py-2 text-sm text-nq-error"
        >
          Could not save ({error}).
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {RELEASE_FEATURE_KEYS.map((key) => {
          const desc = RELEASE_FEATURES[key];
          const on = states[key];
          const busy = pendingKey === key;
          return (
            <li
              key={key}
              className="flex items-center justify-between gap-3 rounded-xl border border-nq-border/40 bg-nq-surface/40 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-nq-foreground">
                    {desc.label}
                  </span>
                  <span className="rounded-full border border-nq-border/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-nq-muted">
                    {desc.phase}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-nq-muted">{desc.description}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`${desc.label} platform visibility`}
                disabled={busy}
                onClick={() => toggle(key, !on)}
                className={cn(
                  "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50",
                  on ? "bg-nq-success" : "bg-nq-error/70",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform",
                    on ? "translate-x-[22px]" : "translate-x-0.5",
                  )}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
