"use client";

import {
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/shared/lib/cn";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "@/shared/lib/motionClient";

const DRAWER_MOTION = {
  slowSec: 0.35,
  easeEnter: [0.16, 1, 0.3, 1] as const,
  easeExit: [0.7, 0, 0.84, 0] as const,
} as const;

export type DrawerVariant = "right" | "bottom";
export type DrawerSize = "sm" | "md" | "lg";

const rightSizeClasses: Record<DrawerSize, string> = {
  sm: "w-80",
  md: "w-120",
  lg: "w-160",
};

const FOCUSABLE_SELECTORS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type DrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  variant?: DrawerVariant;
  size?: DrawerSize;
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  showCloseButton?: boolean;
  className?: string;
  children?: ReactNode;
  "aria-label"?: string;
};

export function Drawer({
  isOpen,
  onClose,
  variant = "right",
  size = "md",
  title,
  description,
  footer,
  showCloseButton = true,
  className,
  children,
  "aria-label": ariaLabel,
}: DrawerProps) {
  const reduced = useReducedMotion();
  const reactId = useId();
  const titleId = title ? `${reactId}-title` : undefined;
  const descId = description ? `${reactId}-desc` : undefined;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR portal: document.body unavailable on server; must set after hydration
    setContainer(document.body);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    lastFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => {
      panelRef.current?.focus();
    }, 0);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;

      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
      );
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || active === panel) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = prevOverflow;
      lastFocusedRef.current?.focus?.();
    };
  }, [isOpen]);

  if (!container) return null;

  const slideInitial = variant === "right" ? { x: "100%" } : { y: "100%" };
  const slideExit = variant === "right" ? { x: "100%" } : { y: "100%" };
  const slideEnter = variant === "right" ? { x: 0 } : { y: 0 };

  const enterTransition = {
    duration: reduced ? 0 : DRAWER_MOTION.slowSec,
    ease: DRAWER_MOTION.easeEnter,
  };
  const exitTransition = {
    duration: reduced ? 0 : DRAWER_MOTION.slowSec,
    ease: DRAWER_MOTION.easeExit,
  };

  const ariaLabelledBy = titleId;
  const ariaLabelOnly = !titleId ? ariaLabel : undefined;

  return createPortal(
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          key="drawer-backdrop"
          aria-hidden
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={enterTransition}
          className="fixed inset-0 z-40 bg-nq-bg/70"
        />
      ) : null}
      {isOpen ? (
        <motion.div
          key="drawer-panel"
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={ariaLabelledBy}
          aria-describedby={descId}
          aria-label={ariaLabelOnly}
          tabIndex={-1}
          initial={slideInitial}
          animate={slideEnter}
          exit={{ ...slideExit, transition: exitTransition }}
          transition={enterTransition}
          className={cn(
            "fixed z-50 flex flex-col bg-nq-surface shadow-nq-card outline-none",
            variant === "right"
              ? cn(
                  "right-0 top-0 h-full max-w-full border-l border-nq-border",
                  rightSizeClasses[size],
                )
              : "bottom-0 left-0 right-0 max-h-screen rounded-t-2xl border-t border-nq-border",
            className,
          )}
        >
          {title || description || showCloseButton ? (
            <div className="flex shrink-0 items-start gap-3 border-b border-nq-border p-4">
              <div className="min-w-0 flex-1">
                {title ? (
                  <h2
                    id={titleId}
                    className="truncate text-lg font-semibold text-nq-foreground"
                  >
                    {title}
                  </h2>
                ) : null}
                {description ? (
                  <p id={descId} className="mt-1 text-sm text-nq-muted">
                    {description}
                  </p>
                ) : null}
              </div>
              {showCloseButton ? (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className={cn(
                    "inline-flex shrink-0 items-center justify-center rounded-full",
                    "min-h-11 min-w-11 text-nq-muted",
                    "hover:bg-nq-bg/40 hover:text-nq-foreground",
                    "transition-colors duration-nq-fast motion-reduce:transition-none",
                    "outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-surface",
                  )}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="20"
                    height="20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden
                  >
                    <path d="M6 6L18 18" />
                    <path d="M18 6L6 18" />
                  </svg>
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>

          {footer ? (
            <div className="shrink-0 border-t border-nq-border p-4">
              {footer}
            </div>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    container,
  );
}

export default Drawer;
