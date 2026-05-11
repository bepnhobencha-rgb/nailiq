"use client";

/**
 * User (owner / dashboard / marketing) language: English or Vietnamese.
 *
 * State is owned by `UserLanguageProvider` (mounted at the root layout).
 * All consumers share the same React state, so a language change in the
 * navbar re-renders every subscriber instantly — no page refresh needed.
 *
 * Persists in `localStorage` (`nailiq-user-lang`), falls back to Vietnamese,
 * and syncs `document.documentElement.lang` on the client.
 */
export { useUserLanguageContext as useUserLanguage } from "./UserLanguageContext";
