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

const MODAL_MOTION = {
  slowSec: 0.35,
  ease: [0.22, 1, 0.36, 1] as const,
} as const;

const MODAL_INITIAL_SCALE = 0.96;

const FOCUSABLE_SELECTORS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type ModalSize = "sm" | "md" | "lg";

const sizeClasses: Record<ModalSize, string> = {
  sm: "w-100 max-w-full",
  md: "w-140 max-w-full",
  lg: "w-180 max-w-full",
};

export type ModalProps = {
  isOpen: boolean;
  onClose: () => void;
  size?: ModalSize;
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  showCloseButton?: boolean;
  closeOnBackdrop?: boolean;
  className?: string;
  children?: ReactNode;
  "aria-label"?: string;
};

export function Modal({
  isOpen,
  onClose,
  size = "md",
  title,
  description,
  footer,
  showCloseButton = true,
  closeOnBackdrop = true,
  className,
  children,
  "aria-label": ariaLabel,
}: ModalProps) {
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

  const ariaLabelledBy = titleId;
  const ariaLabelOnly = !titleId ? ariaLabel : undefined;

  const transition = {
    duration: reduced ? 0 : MODAL_MOTION.slowSec,
    ease: MODAL_MOTION.ease,
  };

  const panelInitial = reduced
    ? { opacity: 0 }
    : { opacity: 0, scale: MODAL_INITIAL_SCALE };
  const panelAnimate = { opacity: 1, scale: 1 };
  const panelExit = reduced
    ? { opacity: 0 }
    : { opacity: 0, scale: MODAL_INITIAL_SCALE };

  return createPortal(
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          key="modal-backdrop"
          aria-hidden
          onClick={closeOnBackdrop ? onClose : undefined}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transition}
          className="fixed inset-0 z-40 bg-nq-bg/70"
        />
      ) : null}
      {isOpen ? (
        <motion.div
          key="modal-panel"
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={ariaLabelledBy}
          aria-describedby={descId}
          aria-label={ariaLabelOnly}
          tabIndex={-1}
          initial={panelInitial}
          animate={panelAnimate}
          exit={panelExit}
          transition={transition}
          transformTemplate={(_, generated) =>
            `translate(-50%, -50%) ${generated}`
          }
          className={cn(
            "fixed left-1/2 top-1/2 z-60 outline-none",
            "flex max-h-screen flex-col rounded-2xl",
            "bg-nq-surface border border-nq-border shadow-nq-card",
            sizeClasses[size],
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

export default Modal;
