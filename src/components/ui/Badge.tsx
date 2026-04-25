import { type HTMLAttributes } from "react";
import { cn } from "@/shared/lib/cn";

export type BadgeVariant = "default" | "success" | "danger" | "muted";

const variantClasses: Record<BadgeVariant, string> = {
  default:
    "border border-nq-border bg-nq-surface/80 text-nq-primary-soft",
  success: "border border-nq-success/35 bg-nq-success/10 text-nq-success",
  danger: "border border-nq-error/40 bg-nq-error/10 text-nq-error",
  muted: "border border-nq-border/60 bg-nq-surface/60 text-nq-muted",
};

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
};

export function Badge({
  className,
  variant = "default",
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full px-2.5 py-0.5 text-xs font-medium tracking-wide",
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
