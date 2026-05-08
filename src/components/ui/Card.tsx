import {
  type ComponentPropsWithoutRef,
  type ElementType,
  type ReactNode,
} from "react";

import { cn } from "@/shared/lib/cn";

export type CardVariant = "default" | "elevated" | "bordered";
export type CardPadding = "none" | "sm" | "md" | "lg";
export type CardState = "static" | "interactive" | "selected";

const variantClasses: Record<CardVariant, string> = {
  default: "bg-nq-surface border border-nq-border",
  elevated: "bg-nq-surface border border-nq-border shadow-nq-card",
  bordered: "bg-transparent border border-nq-border",
};

const paddingClasses: Record<CardPadding, string> = {
  none: "p-0",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

const stateClasses: Record<CardState, string> = {
  static: "",
  interactive: cn(
    "cursor-pointer",
    "hover:bg-nq-surface/90",
    "transition-colors duration-nq-fast motion-reduce:transition-none",
    "outline-none",
    "focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
  ),
  selected: cn(
    "ring-2 ring-nq-primary ring-offset-2 ring-offset-nq-bg",
    "border-nq-primary/60",
  ),
};

type CardOwnProps = {
  variant?: CardVariant;
  padding?: CardPadding;
  state?: CardState;
  className?: string;
  children: ReactNode;
};

export type CardProps<T extends ElementType = "div"> = CardOwnProps & {
  as?: T;
} & Omit<ComponentPropsWithoutRef<T>, keyof CardOwnProps | "as">;

export function Card<T extends ElementType = "div">({
  as,
  variant = "default",
  padding = "md",
  state = "static",
  className,
  children,
  ...rest
}: CardProps<T>) {
  const Component = (as ?? "div") as ElementType;

  return (
    <Component
      className={cn(
        "rounded-2xl",
        variantClasses[variant],
        paddingClasses[padding],
        stateClasses[state],
        className,
      )}
      {...rest}
    >
      {children}
    </Component>
  );
}

export default Card;
