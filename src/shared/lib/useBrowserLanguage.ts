"use client";

import { useEffect, useState } from "react";
import type { UserLanguage } from "@/shared/i18n/user/types";

/**
 * Auth-surface language detection.
 *
 * Reads `navigator.language` after mount and returns "vi" if it starts with
 * "vi", otherwise "en". SSR-safe: always returns "en" on the server and on
 * the first client render, then aligns once the effect runs.
 *
 * Distinct from `useUserLanguage`, which is EN-first and only flips to VI
 * after an explicit user toggle. The auth screen is functional rather than
 * marketing copy, so we lean on the browser hint here.
 */
export function useBrowserLanguage(): UserLanguage {
  const [language, setLanguage] = useState<UserLanguage>("en");

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const tag = navigator.language ?? "";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- navigator unavailable on server; aligns after mount without hydration mismatch
    setLanguage(tag.toLowerCase().startsWith("vi") ? "vi" : "en");
  }, []);

  return language;
}
