import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

export type SectionProps = HTMLAttributes<HTMLElement> & {
  label?: string;
  description?: string;
  children: ReactNode;
};

export function Section({
  className,
  label,
  description,
  children,
  ...props
}: SectionProps) {
  return (
    <section
      className={cn("mx-auto w-full max-w-lg px-4 py-6 sm:max-w-2xl sm:px-6", className)}
      {...props}
    >
      {label != null && label.length > 0 && (
        <div className="mb-3 space-y-1">
          <h2 className="text-sm font-medium tracking-wide text-nq-muted uppercase">
            {label}
          </h2>
          {description != null && description.length > 0 && (
            <p className="text-sm text-nq-muted/90">{description}</p>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
