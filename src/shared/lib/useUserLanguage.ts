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
 * Default is Vietnamese — the primary user base is Vietnamese-speaking nail
 * salon owners. English speakers still get the EN/VI toggle and we persist
 * their choice in `localStorage`. We do NOT auto-pick from
 * `navigator.language` — the toggle is the source of truth.
 */
function getInitialLanguage(): UserLanguage {
  if (typeof window === "undefined") return "vi";

  try {
    const saved = window.localStorage.getItem(USER_LANGUAGE_STORAGE_KEY);
    const fromStored = parseStored(saved);
    if (fromStored) return fromStored;
  } catch {
    /* quota / blocked */
  }

  return "vi";
}

/**
 * User (owner / dashboard / marketing) language: English or Vietnamese.
 * Persists in `localStorage`, falls back to Vietnamese, syncs `document.documentElement.lang` on the client.
 */
export function useUserLanguage() {
  const [language, setLanguageState] = useState<UserLanguage>("vi");

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
