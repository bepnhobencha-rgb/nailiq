"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";

export type SetupToastVariant = "success" | "error";

export type SetupToastPayload = {
  variant: SetupToastVariant;
  message: string;
};

type SetupToastProps = {
  toast: SetupToastPayload | null;
  onDismiss: () => void;
  /** Auto-dismiss after ms (default 3000). Set 0 to disable. */
  autoDismissMs?: number;
};

/** Fixed toast for dashboard setup flows; slide in/out when motion is allowed. */
export function SetupToast({
  toast,
  onDismiss,
  autoDismissMs = 3000,
}: SetupToastProps) {
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState<SetupToastPayload | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }

    if (!toast) {
      setOpen(false);
      exitTimerRef.current = setTimeout(() => {
        setRendered(null);
        exitTimerRef.current = null;
      }, 220);
      return;
    }

    setRendered(toast);
    requestAnimationFrame(() => setOpen(true));

    if (autoDismissMs > 0) {
      dismissTimerRef.current = setTimeout(() => {
        onDismissRef.current();
        dismissTimerRef.current = null;
      }, autoDismissMs);
    }

    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, [toast, autoDismissMs]);

  if (!rendered) return null;

  const success = rendered.variant === "success";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed z-[100] px-4 pb-safe sm:px-0 sm:pb-4",
        "bottom-0 left-0 right-0 sm:bottom-auto sm:left-auto sm:right-4 sm:top-auto",
        "flex justify-end sm:justify-start",
      )}
    >
      <div
        className={cn(
          "pointer-events-auto w-full max-w-[min(100%,var(--max-nq-mobile))] sm:max-w-[min(320px,calc(100vw-2rem))]",
          "rounded-[12px] border px-4 py-3 text-[13px] leading-snug text-nq-foreground shadow-nq-card",
          "bg-nq-surface/95 backdrop-blur-sm",
          success
            ? "border-nq-success/40"
            : "border-nq-error/40",
          "motion-safe:transition-[transform,opacity] motion-safe:duration-200 motion-safe:ease-out motion-reduce:transition-none",
          open
            ? "translate-x-0 opacity-100"
            : "translate-x-full opacity-0 motion-reduce:translate-x-0",
        )}
      >
        {rendered.message}
      </div>
    </div>
  );
}
