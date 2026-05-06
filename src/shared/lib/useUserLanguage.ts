"use client";

import { useCallback, useEffect, useState } from "react";
import {
  USER_LANGUAGES,
  USER_LANGUAGE_STORAGE_KEY,
  type UserLanguage,
} from "@/shared/i18n/user/types";

function parseStored(value: string | null): UserLanguage | null {
  if (!value) return null;
  return USER_LANGUAGES.includes(value as UserLanguage)
    ? (value as UserLanguage)
    : null;
}

/**
 * SSR-safe snapshot: only call with `window` present.
 * Default is always English; Vietnamese is set only when the user has
 * explicitly toggled VI (persisted in `localStorage`). We do NOT auto-pick
 * VI from `navigator.language` — the public surfaces are EN-first.
 */
function getInitialLanguage(): UserLanguage {
  if (typeof window === "undefined") return "en";

  try {
    const saved = window.localStorage.getItem(USER_LANGUAGE_STORAGE_KEY);
    const fromStored = parseStored(saved);
    if (fromStored) return fromStored;
  } catch {
    /* quota / blocked */
  }

  return "en";
}

/**
 * User (owner / dashboard / marketing) language: English or Vietnamese.
 * Persists in `localStorage`, falls back to English, syncs `document.documentElement.lang` on the client.
 */
export function useUserLanguage() {
  const [language, setLanguageState] = useState<UserLanguage>("en");

  useEffect(() => {
    const next = getInitialLanguage();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage/navigator unavailable on server; aligns after mount without hydration mismatch
    setLanguageState(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === "vi" ? "vi" : "en";
  }, [language]);

  const setLanguage = useCallback((next: UserLanguage) => {
    setLanguageState(next);
    try {
      window.localStorage.setItem(USER_LANGUAGE_STORAGE_KEY, next);
    } catch {
      /* ignore quota / private mode */
    }
  }, []);

  const toggleLanguage = useCallback(() => {
    setLanguageState((current) => {
      const next = current === "en" ? "vi" : "en";
      try {
        window.localStorage.setItem(USER_LANGUAGE_STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return { language, setLanguage, toggleLanguage };
}
