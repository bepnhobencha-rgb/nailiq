import { userEn, type UserMessages } from "./en";
import { userVi } from "./vi";
import type { UserLanguage } from "./types";

const byLang: Record<UserLanguage, UserMessages> = {
  en: userEn,
  vi: userVi,
};

export function getUserMessages(language: UserLanguage): UserMessages {
  return byLang[language] ?? userEn;
}

export { userEn, userVi, type UserMessages };
export type { UserLanguage } from "./types";
export {
  USER_LANGUAGES,
  USER_LANGUAGE_STORAGE_KEY,
} from "./types";
