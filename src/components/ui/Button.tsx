"use client";

import {
  type ButtonHTMLAttributes,
  forwardRef,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/shared/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-nq-primary text-nq-bg shadow-nq-sm hover:bg-nq-primary-soft focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
  secondary:
    "bg-nq-surface text-nq-primary border border-nq-border hover:bg-nq-surface/90 focus-visible:ring-2 focus-visible:ring-nq-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
  ghost:
    "text-nq-primary-soft hover:bg-nq-surface/80 focus-visible:ring-2 focus-visible:ring-nq-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
  danger:
    "bg-nq-error text-nq-foreground shadow-nq-sm hover:opacity-95 focus-visible:ring-2 focus-visible:ring-nq-error focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-10 min-h-10 px-4 text-sm",
  md: "h-11 min-h-11 px-5 text-sm",
  lg: "h-14 min-h-14 px-6 text-base font-medium",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      type = "button",
      variant = "primary",
      size = "md",
      disabled,
      onClick,
      ...props
    },
    ref,
  ) {
    const [clickFlash, setClickFlash] = useState(false);
    const clickFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );

    useEffect(
      () => () => {
        if (clickFlashTimerRef.current !== null) {
          clearTimeout(clickFlashTimerRef.current);
        }
      },
      [],
    );

    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled}
        onClick={(e) => {
          onClick?.(e);
          if (disabled) return;
          if (clickFlashTimerRef.current !== null) {
            clearTimeout(clickFlashTimerRef.current);
          }
          setClickFlash(true);
          clickFlashTimerRef.current = setTimeout(() => {
            setClickFlash(false);
            clickFlashTimerRef.current = null;
          }, 100);
        }}
        className={cn(
          "inline-flex w-full min-w-0 max-w-full cursor-pointer items-center justify-center rounded-full border border-transparent",
          "shadow-[0_0_30px_rgba(212,175,55,0.2)]",
          "transition-all duration-150 ease-out motion-reduce:transition-transform motion-reduce:duration-200",
          "hover:scale-[1.02] active:scale-[0.98] motion-reduce:hover:scale-100 motion-reduce:active:scale-100",
          clickFlash && "opacity-90",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100 disabled:active:scale-100 sm:w-auto",
          variantClasses[variant],
          sizeClasses[size],
          className,
        )}
        {...props}
      />
    );
  },
);
