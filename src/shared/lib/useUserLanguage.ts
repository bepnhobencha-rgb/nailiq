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
 * User (owner / dashboard / marketing) language: English or Vietnamese.
 * Persists in `localStorage`, falls back to English, syncs `document.documentElement.lang` on the client.
 */
export function useUserLanguage() {
  const [language, setLanguageState] = useState<UserLanguage>("en");

  useEffect(() => {
    const fromStorage = parseStored(
      window.localStorage.getItem(USER_LANGUAGE_STORAGE_KEY),
    );
    if (fromStorage) {
      // Re-sync persisted preference after mount; avoids hydration mismatch with SSR.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is unavailable on server; one-time rehydration
      setLanguageState(fromStorage);
    }
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
