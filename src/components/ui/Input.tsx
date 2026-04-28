import { type InputHTMLAttributes, forwardRef } from "react";
import { cn } from "@/shared/lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  error?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, error, type = "text", "aria-invalid": ariaInvalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={error === true || ariaInvalid}
      className={cn(
        "min-h-[52px] w-full min-w-0 rounded-2xl border bg-nq-surface px-4 py-3.5 text-base text-nq-foreground outline-none",
        "transition-all duration-200 ease-out will-change-[box-shadow]",
        "placeholder:text-nq-muted",
        "border-nq-border",
        !error &&
          "focus:border-nq-primary focus:ring-2 focus:ring-nq-primary/50 focus:ring-offset-0 focus:shadow-[0_0_0_3px_rgba(212,175,55,0.32),0_0_28px_-4px_rgba(212,175,55,0.18),0_0_20px_rgba(212,175,55,0.25)]",
        error &&
          "border-nq-error focus:border-nq-error focus:ring-0 focus:shadow-nq-input-error",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
});
