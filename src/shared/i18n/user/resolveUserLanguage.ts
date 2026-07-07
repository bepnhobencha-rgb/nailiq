import { cookies } from "next/headers";
import { createClient } from "@/shared/lib/supabase/server";
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
 *   2. Default `en` — English is the product default; the visitor opts
 *      into Vietnamese explicitly via the toggle (persisted to the cookie),
 *      and that choice then sticks for every page. We intentionally do NOT
 *      auto-switch off `Accept-Language` so the first paint is predictable.
 *
 * Note: distinct from `resolveBookingLanguage` in `i18n/booking` — the
 * public booking page intentionally keeps its own cookie/story so
 * salon-owner UI and customer-facing UI can diverge per surface.
 */
export async function resolveUserLanguage(): Promise<UserLanguage> {
  // 1. A logged-in user's saved account language wins — it follows them across
  //    devices (set via /api/user/language). Anonymous visitors skip this.
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const acct = user?.user_metadata?.user_language;
    if (typeof acct === "string" && USER_LANGUAGES.includes(acct as UserLanguage)) {
      return acct as UserLanguage;
    }
  } catch {
    /* anonymous / auth unavailable → fall through to cookie */
  }

  // 2. The explicit per-device toggle choice.
  const cookieStore = await cookies();
  const cookieVal = cookieStore.get(USER_LANGUAGE_COOKIE)?.value;
  if (cookieVal && USER_LANGUAGES.includes(cookieVal as UserLanguage)) {
    return cookieVal as UserLanguage;
  }

  // 3. Product default.
  return "en";
}
