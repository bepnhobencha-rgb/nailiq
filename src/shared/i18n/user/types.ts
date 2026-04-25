export const USER_LANGUAGES = ["en", "vi"] as const;

export type UserLanguage = (typeof USER_LANGUAGES)[number];

export const USER_LANGUAGE_STORAGE_KEY = "nailiq-user-lang";
