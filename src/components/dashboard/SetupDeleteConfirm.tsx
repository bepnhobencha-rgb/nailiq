"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";

type SetupDeleteConfirmProps = {
  /** e.g. `Delete Gel Manicure?` */
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
};

/** Inline replace for delete row: auto-cancel after 5s. */
export function SetupDeleteConfirm({
  title,
  onCancel,
  onConfirm,
  busy = false,
}: SetupDeleteConfirmProps) {
  const cancelRef = useRef(onCancel);
  /* Mutate the ref inside an effect rather than during render — `cancelRef.current = onCancel`
     directly in the body trips react-hooks/refs and is a real anti-pattern in React 19
     concurrent rendering. */
  useEffect(() => {
    cancelRef.current = onCancel;
  });

  useEffect(() => {
    const t = window.setTimeout(() => cancelRef.current(), 5000);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm font-medium leading-snug text-nq-foreground">{title}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          type="button"
          variant="ghost"
          size="lg"
          className="min-h-11 w-full sm:w-auto"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="danger"
          size="lg"
          className="min-h-11 w-full sm:w-auto"
          disabled={busy}
          onClick={onConfirm}
        >
          Confirm delete
        </Button>
      </div>
    </div>
  );
}
