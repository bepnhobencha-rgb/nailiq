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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR hydration: localStorage wins over cookie after first paint
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

  // One-tap language switch via deep-link `?setLang=vi|en`. Lets Coco (admin
  // copilot) hand the user a button that ACTUALLY switches the dashboard
  // language instead of only describing where the toggle is. Apply once on
  // mount, then strip the param so a refresh/share doesn't re-trigger it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const requested = parseStored(params.get("setLang"));
    if (!requested) return;
    // Persist first so the reload's SSR reads the new cookie, then FULL reload
    // to the cleaned URL. A client-only state change leaves server-rendered
    // pages in the old language (only client bits switch) — reloading re-renders
    // the whole app, server included, in the new language.
    setLanguage(requested);
    params.delete("setLang");
    const qs = params.toString();
    const url =
      window.location.pathname +
      (qs ? `?${qs}` : "") +
      window.location.hash;
    window.location.replace(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once; setLanguage is stable
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
