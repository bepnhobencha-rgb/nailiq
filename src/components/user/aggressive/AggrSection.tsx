import { type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

type AggrSectionProps = {
  children: ReactNode;
  className?: string;
  as?: "section" | "div";
};

const pad = "px-0 py-10 sm:py-14";

/**
 * Single-column spacing wrapper for the aggressive landing (no complex grid).
 */
export function AggrSection({
  children,
  className,
  as: Comp = "section",
}: AggrSectionProps) {
  return <Comp className={cn("w-full", pad, className)}>{children}</Comp>;
}
