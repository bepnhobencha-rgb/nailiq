"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  USER_LANGUAGES,
  USER_LANGUAGE_STORAGE_KEY,
  type UserLanguage,
} from "@/shared/i18n/user/types";

type UserLanguageContextValue = {
  language: UserLanguage;
  setLanguage: (next: UserLanguage) => void;
  toggleLanguage: () => void;
};

export const UserLanguageContext =
  createContext<UserLanguageContextValue | null>(null);

function parseStored(value: string | null): UserLanguage | null {
  if (!value) return null;
  return USER_LANGUAGES.includes(value as UserLanguage)
    ? (value as UserLanguage)
    : null;
}

function getStoredLanguage(): UserLanguage {
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
 * Single source of truth for the user language (EN / VI).
 * Mount once at the root layout so all `useUserLanguage()` consumers
 * share the same React state and re-render together on language change
 * — no page refresh required.
 */
export function UserLanguageProvider({ children }: { children: ReactNode }) {
  // SSR default "vi"; corrected after first client mount from localStorage.
  const [language, setLanguageState] = useState<UserLanguage>("vi");

  useEffect(() => {
    // Align with persisted preference after hydration.
    setLanguageState(getStoredLanguage());
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

  return (
    <UserLanguageContext.Provider value={{ language, setLanguage, toggleLanguage }}>
      {children}
    </UserLanguageContext.Provider>
  );
}

/**
 * Reads the shared language state from `UserLanguageProvider`.
 * Must be called inside a component that is a descendant of the provider.
 */
export function useUserLanguageContext(): UserLanguageContextValue {
  const ctx = useContext(UserLanguageContext);
  if (!ctx) {
    throw new Error(
      "useUserLanguageContext must be used within <UserLanguageProvider>",
    );
  }
  return ctx;
}
