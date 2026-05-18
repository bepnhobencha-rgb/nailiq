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
  USER_LANGUAGE_COOKIE,
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

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function parseStored(value: string | null): UserLanguage | null {
  if (!value) return null;
  return USER_LANGUAGES.includes(value as UserLanguage)
    ? (value as UserLanguage)
    : null;
}

function readStoredLanguage(): UserLanguage | null {
  if (typeof window === "undefined") return null;
  try {
    return parseStored(window.localStorage.getItem(USER_LANGUAGE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function persistLanguage(next: UserLanguage) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(USER_LANGUAGE_STORAGE_KEY, next);
  } catch {
    /* quota / blocked */
  }
  // Mirror to a cookie so the SSR resolver can render the saved language
  // on the next request without a hydration flash.
  document.cookie = `${USER_LANGUAGE_COOKIE}=${next}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

/**
 * Single source of truth for the user language (EN / VI).
 * Mount once at the root layout so all `useUserLanguage()` consumers
 * share the same React state and re-render together on language change
 * — no page refresh required.
 *
 * `initialLanguage` is computed server-side from cookie + Accept-Language
 * (see `resolveUserLanguage`), so the very first paint matches what the
 * visitor expects. localStorage still wins after hydration to keep
 * cross-tab parity when the cookie and stored value disagree.
 */
export function UserLanguageProvider({
  children,
  initialLanguage = "en",
}: {
  children: ReactNode;
  initialLanguage?: UserLanguage;
}) {
  const [language, setLanguageState] = useState<UserLanguage>(initialLanguage);

  useEffect(() => {
    const stored = readStoredLanguage();
    if (stored && stored !== language) {
      setLanguageState(stored);
    }
    // Run once on mount — server-resolved initialLanguage is authoritative
    // for the first render; localStorage takes over from there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Some browsers reset scroll when `document.documentElement.lang` changes.
    // Save and restore to prevent the page jumping to the top on toggle.
    const saved = typeof window !== "undefined" ? window.scrollY : 0;
    document.documentElement.lang = language === "vi" ? "vi" : "en";
    if (typeof window !== "undefined" && window.scrollY !== saved) {
      window.scrollTo(0, saved);
    }
  }, [language]);

  const setLanguage = useCallback((next: UserLanguage) => {
    setLanguageState(next);
    persistLanguage(next);
  }, []);

  const toggleLanguage = useCallback(() => {
    setLanguageState((current) => {
      const next = current === "en" ? "vi" : "en";
      persistLanguage(next);
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
