import { type HTMLAttributes, type ReactNode } from "react";

import { cn } from "@/shared/lib/cn";

export type BadgeVariant =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "vip"
  | "neutral";

export type BadgeSize = "sm" | "md" | "lg";
export type BadgeState = "default" | "subtle";

type LegacyBadgeVariant = "default" | "muted";

const variantClassesByState: Record<
  BadgeState,
  Record<BadgeVariant, string>
> = {
  default: {
    success: "bg-nq-success/15 border-nq-success/40 text-nq-success",
    warning: "bg-nq-warning/15 border-nq-warning/40 text-nq-warning",
    danger: "bg-nq-error/15 border-nq-error/40 text-nq-error",
    info: "bg-nq-info/15 border-nq-info/40 text-nq-info",
    vip: "bg-nq-primary/15 border-nq-primary/45 text-nq-primary",
    neutral: "bg-nq-surface border-nq-border text-nq-foreground",
  },
  subtle: {
    success: "bg-nq-success/10 border-transparent text-nq-success",
    warning: "bg-nq-warning/10 border-transparent text-nq-warning",
    danger: "bg-nq-error/10 border-transparent text-nq-error",
    info: "bg-nq-info/10 border-transparent text-nq-info",
    vip: "bg-nq-primary/10 border-transparent text-nq-primary",
    neutral: "bg-nq-surface/60 border-transparent text-nq-muted",
  },
};

const sizeClasses: Record<BadgeSize, string> = {
  sm: "px-1.5 py-0 text-xs gap-1",
  md: "px-2.5 py-0.5 text-xs gap-1.5",
  lg: "px-3 py-1 text-sm gap-2",
};

const dotSizeClasses: Record<BadgeSize, string> = {
  sm: "h-1.5 w-1.5",
  md: "h-2 w-2",
  lg: "h-2.5 w-2.5",
};

function resolveVariant(
  variant: BadgeVariant | LegacyBadgeVariant,
): BadgeVariant {
  if (variant === "default" || variant === "muted") return "neutral";
  return variant;
}

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant | LegacyBadgeVariant;
  size?: BadgeSize;
  state?: BadgeState;
  dot?: boolean;
  leftIcon?: ReactNode;
  children?: ReactNode;
};

export function Badge({
  className,
  variant = "neutral",
  size = "md",
  state = "default",
  dot = false,
  leftIcon,
  children,
  ...rest
}: BadgeProps) {
  const resolvedVariant = resolveVariant(variant);

  return (
    <span
      className={cn(
        "inline-flex max-w-full select-none items-center rounded-full border font-medium tracking-wide",
        sizeClasses[size],
        variantClassesByState[state][resolvedVariant],
        className,
      )}
      {...rest}
    >
      {leftIcon ? (
        <span className="inline-flex shrink-0" aria-hidden>
          {leftIcon}
        </span>
      ) : null}
      {dot ? (
        <span
          aria-hidden
          className={cn(
            "inline-block shrink-0 rounded-full bg-current",
            dotSizeClasses[size],
          )}
        />
      ) : null}
      {children !== undefined && children !== null ? (
        <span className="min-w-0 truncate">{children}</span>
      ) : null}
    </span>
  );
}

export default Badge;
