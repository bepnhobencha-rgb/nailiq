"use client";

import { cn } from "@/shared/lib/cn";

export type SaveButtonStatus = "idle" | "saving" | "saved" | "error";

type SaveButtonProps = {
  status: SaveButtonStatus;
  onSave: () => void;
  idleLabel?: string;
  savedLabel?: string;
  savingLabel?: string;
  errorLabel?: string;
  className?: string;
  disabled?: boolean;
};

function SmallSpinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none",
        className,
      )}
      aria-hidden
    />
  );
}

export function SaveButton({
  status,
  onSave,
  idleLabel = "Save",
  savedLabel = "✓ Saved",
  savingLabel = "Saving...",
  errorLabel = "Save failed — try again",
  className,
  disabled = false,
}: SaveButtonProps) {
  const isSaving = status === "saving";
  const isSaved = status === "saved";
  const isError = status === "error";
  const isIdle = status === "idle";

  const label = isSaving
    ? savingLabel
    : isSaved
      ? savedLabel
      : isError
        ? errorLabel
        : idleLabel;

  return (
    <button
      type="button"
      disabled={disabled || isSaving || isSaved || isError}
      onClick={() => {
        if (isIdle && !disabled) onSave();
      }}
      className={cn(
        "inline-flex min-h-11 w-full max-w-full touch-manipulation items-center justify-center gap-2 rounded-full px-6 text-base font-medium shadow-nq-sm",
        "transition-[opacity,transform,background-color,color] duration-150 motion-reduce:transition-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
        "disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto",
        isIdle &&
          !disabled &&
          "bg-nq-primary text-nq-bg hover:opacity-95 active:scale-[0.99] motion-reduce:active:scale-100",
        isIdle && disabled && "bg-nq-primary/50 text-nq-bg/80",
        isSaving && "bg-nq-primary text-nq-bg !opacity-70 disabled:opacity-70",
        isSaved && "bg-nq-success text-nq-foreground !opacity-100 disabled:opacity-100",
        isError && "bg-nq-error text-nq-foreground !opacity-100 disabled:opacity-100",
        className,
      )}
    >
      {isSaving ? (
        <>
          <SmallSpinner className="border-nq-bg/80 border-t-transparent" />
          <span>{label}</span>
        </>
      ) : (
        <span>{label}</span>
      )}
    </button>
  );
}
