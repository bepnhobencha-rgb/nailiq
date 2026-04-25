import { type HTMLAttributes } from "react";
import { cn } from "@/shared/lib/cn";

export type CardProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "relative z-0 overflow-hidden rounded-3xl p-7 ring-1 ring-inset ring-nq-primary/25 sm:p-8",
        "glass glow-gold shadow-nq-card-luxury",
        "before:pointer-events-none before:absolute before:inset-0 before:rounded-3xl before:bg-gradient-to-br before:from-nq-primary/10 before:via-nq-surface/40 before:to-nq-primary/5",
        "after:pointer-events-none after:absolute after:inset-0 after:z-[1] after:rounded-3xl after:bg-gradient-to-b after:from-white/5 after:to-transparent",
        "motion-safe:transition motion-safe:duration-200 motion-safe:ease-out motion-safe:hover:-translate-y-0.5",
        "motion-safe:hover:shadow-[0_12px_48px_-10px_rgba(0,0,0,0.5),0_0_40px_rgba(212,175,55,0.12)]",
        className,
      )}
      {...props}
    />
  );
}
