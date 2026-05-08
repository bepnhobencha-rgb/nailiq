"use client";

import {
  type ButtonHTMLAttributes,
  type ReactNode,
  forwardRef,
} from "react";

import { cn } from "@/shared/lib/cn";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";

const BUTTON_MOTION = {
  fastSec: 0.1,
  ease: [0.22, 1, 0.36, 1] as const,
} as const;

const PRESS_SCALE = 0.97;

const SPINNER_PERIOD_SEC = 0.6;

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

type NativeButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  | "onDrag"
  | "onDragStart"
  | "onDragEnd"
  | "onDragEnter"
  | "onDragLeave"
  | "onDragOver"
  | "onDragExit"
  | "onAnimationStart"
  | "onAnimationEnd"
  | "onAnimationIteration"
  | "onTransitionEnd"
>;

export type ButtonProps = NativeButtonProps & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-nq-primary text-nq-bg shadow-nq-sm hover:bg-nq-primary-soft focus-visible:ring-nq-primary",
  secondary:
    "bg-nq-surface text-nq-foreground border border-nq-border hover:bg-nq-surface/90 focus-visible:ring-nq-primary/60",
  ghost:
    "bg-transparent text-nq-foreground hover:bg-nq-surface/80 focus-visible:ring-nq-primary/50",
  danger:
    "bg-nq-error text-nq-foreground shadow-nq-sm hover:opacity-95 focus-visible:ring-nq-error",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm before:content-[''] before:absolute before:inset-x-0 before:-inset-y-1.5",
  md: "h-10 px-4 text-sm before:content-[''] before:absolute before:inset-x-0 before:-inset-y-0.5",
  lg: "h-12 px-6 text-base font-medium",
};

const spinnerSizeClasses: Record<ButtonSize, string> = {
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
  lg: "h-5 w-5",
};

function ButtonSpinner({ size }: { size: ButtonSize }) {
  const reduced = useReducedMotion();
  return (
    <motion.span
      aria-hidden
      className={cn(
        "inline-block rounded-full border-2 border-current border-t-transparent",
        spinnerSizeClasses[size],
      )}
      animate={reduced ? undefined : { rotate: 360 }}
      transition={
        reduced
          ? undefined
          : {
              repeat: Infinity,
              ease: "linear",
              duration: SPINNER_PERIOD_SEC,
            }
      }
    />
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      type = "button",
      variant = "primary",
      size = "md",
      disabled,
      loading = false,
      leftIcon,
      rightIcon,
      fullWidth = false,
      children,
      ...rest
    },
    ref,
  ) {
    const reduced = useReducedMotion();
    const blocked = Boolean(disabled || loading);

    return (
      <motion.button
        ref={ref}
        type={type}
        disabled={blocked}
        aria-disabled={blocked || undefined}
        aria-busy={loading || undefined}
        whileTap={reduced || blocked ? undefined : { scale: PRESS_SCALE }}
        transition={{
          duration: BUTTON_MOTION.fastSec,
          ease: BUTTON_MOTION.ease,
        }}
        className={cn(
          "relative inline-flex items-center justify-center gap-2 rounded-full",
          "border border-transparent select-none whitespace-nowrap font-medium",
          "transition-colors duration-nq-base motion-reduce:transition-none",
          "outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
          "disabled:cursor-not-allowed disabled:opacity-50",
          variantClasses[variant],
          sizeClasses[size],
          fullWidth ? "w-full" : "w-auto",
          className,
        )}
        {...rest}
      >
        <span
          className={cn(
            "inline-flex min-w-0 items-center gap-2",
            loading && "opacity-0",
          )}
        >
          {leftIcon ? (
            <span className="inline-flex shrink-0" aria-hidden>
              {leftIcon}
            </span>
          ) : null}
          {children !== undefined ? (
            <span className="min-w-0 truncate">{children}</span>
          ) : null}
          {rightIcon ? (
            <span className="inline-flex shrink-0" aria-hidden>
              {rightIcon}
            </span>
          ) : null}
        </span>

        {loading ? (
          <span className="pointer-events-none absolute inset-0 inline-flex items-center justify-center">
            <ButtonSpinner size={size} />
          </span>
        ) : null}
      </motion.button>
    );
  },
);

Button.displayName = "Button";

export default Button;
