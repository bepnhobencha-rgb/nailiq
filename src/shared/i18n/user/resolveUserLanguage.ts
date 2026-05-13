import { cookies, headers } from "next/headers";
import {
  USER_LANGUAGE_COOKIE,
  USER_LANGUAGES,
  type UserLanguage,
} from "./types";

/**
 * Server helper: pick the user-surface locale (landing, dashboard,
 * customer-wait, register/login) for the very first paint.
 *
 * Priority:
 *   1. `nailiq-user-lang` cookie — the explicit choice the visitor made
 *      via the EN/VI toggle (kept in sync with localStorage by the
 *      client provider).
 *   2. `Accept-Language` header — if the primary tag starts with `vi`
 *      (e.g. `vi-VN`), serve Vietnamese.
 *   3. Fallback `en`. Anything else (fr, zh, en-US, …) gets English so
 *      international visitors land on a language they can read.
 *
 * Note: distinct from `resolveBookingLanguage` in `i18n/booking` — the
 * public booking page intentionally keeps its own cookie/story so
 * salon-owner UI and customer-facing UI can diverge per surface.
 */
export async function resolveUserLanguage(): Promise<UserLanguage> {
  const cookieStore = await cookies();
  const cookieVal = cookieStore.get(USER_LANGUAGE_COOKIE)?.value;
  if (cookieVal && USER_LANGUAGES.includes(cookieVal as UserLanguage)) {
    return cookieVal as UserLanguage;
  }

  const headerStore = await headers();
  const accept = headerStore.get("accept-language") ?? "";
  const primary = accept.split(",")[0]?.trim().toLowerCase() ?? "";
  return primary.startsWith("vi") ? "vi" : "en";
}
