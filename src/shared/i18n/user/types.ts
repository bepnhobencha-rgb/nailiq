export const USER_LANGUAGES = ["en", "vi"] as const;

export type UserLanguage = (typeof USER_LANGUAGES)[number];

export const USER_LANGUAGE_STORAGE_KEY = "nailiq-user-lang";

/** Server-readable mirror of the localStorage preference. Written by the
 * client toggle so SSR can render the saved language on return visits
 * without a localStorage-driven flash after hydration. */
export const USER_LANGUAGE_COOKIE = "nailiq-user-lang";
