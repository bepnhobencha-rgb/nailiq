"use client";

import { useRef, useState, useTransition } from "react";

export type ImmediateSettingSaveStatus =
  | "idle"
  | "saving"
  | "saved"
  | "error";

type SaveResult<T> = { ok: true; value: T } | { ok: false };

type Options<T> = {
  initialValue: T;
  save: (value: T) => Promise<SaveResult<T>>;
};

/**
 * Safely persists one discrete setting as soon as the user selects it.
 *
 * Only one write may be in flight. The selected value updates immediately,
 * then rolls back to the last server-confirmed value if the write fails.
 */
export function useImmediateSettingSave<T>({
  initialValue,
  save,
}: Options<T>) {
  const [value, setValue] = useState(initialValue);
  const [status, setStatus] =
    useState<ImmediateSettingSaveStatus>("idle");
  const [isPending, startTransition] = useTransition();
  const committedValue = useRef(initialValue);
  const isSaving = useRef(false);

  function change(nextValue: T) {
    if (isSaving.current || Object.is(value, nextValue)) return;

    const previousValue = committedValue.current;
    isSaving.current = true;
    setValue(nextValue);
    setStatus("saving");

    startTransition(async () => {
      let result: SaveResult<T>;
      try {
        result = await save(nextValue);
      } catch {
        result = { ok: false };
      }

      if (result.ok) {
        committedValue.current = result.value;
        setValue(result.value);
        setStatus("saved");
      } else {
        setValue(previousValue);
        setStatus("error");
      }
      isSaving.current = false;
    });
  }

  return {
    value,
    status,
    isSaving: status === "saving" || isPending,
    change,
  };
}
