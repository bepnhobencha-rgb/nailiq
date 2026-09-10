"use client";

import { useState, useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import type { SignOutResult } from "./signOutResponse";

/** Successful actions redirect; returned/rejected responses need explicit retry. */
export function useSignOutAction(action: () => Promise<SignOutResult>) {
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  const run = () => {
    setFailed(false);
    startTransition(async () => {
      try {
        await action();
      } catch (error) {
        // Next uses a rejected redirect signal for a successful Server Action.
        unstable_rethrow(error);
      }
      // A lost response does not prove whether logout happened. Do not replay it.
      setFailed(true);
    });
  };

  return { pending, failed, run, clearFailure: () => setFailed(false) };
}
