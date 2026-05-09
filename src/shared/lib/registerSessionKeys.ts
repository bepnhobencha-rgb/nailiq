/**
 * Register-flow sessionStorage keys.
 *
 * **Migration status (2026-05-09):**
 *   The completion-token hop (`/register/verify` → `/register/setup`) now
 *   threads the token through the URL as `?ct=…` so reload survives.
 *   `RegisterSetupInner` reads the URL param first and falls back to
 *   sessionStorage for in-flight tabs that started before this change.
 *   The server-side flow state lives in
 *   `register_completion_tokens.payload` (see migration
 *   `20260509230000_register_completion_tokens_payload.sql`); the
 *   `loadRegisterFlowState(token)` server action reads it.
 *
 * Remaining sessionStorage usage is now strictly for cosmetic UX
 * (returning-owner copy, otp-resent toast) and the phone-digits hand-off
 * between `/register` and `/register/verify`. Those losses on reload are
 * recoverable by re-entering the phone — operationally tolerable and not
 * blocking salon creation.
 *
 * Future cleanup: once monitoring shows no more in-flight sessions
 * relying on `REG_COMPLETION_TOKEN_KEY` (e.g. 24h after deploy), the
 * sessionStorage write in `VerifyPageClient` and the read fallback in
 * `RegisterSetupInner` can drop. The constant stays exported until
 * then so existing tabs keep working.
 */

/** Transient phone digits between /register → /verify (sessionStorage only).
 *  No server-side fallback — losing this on reload sends the user back to
 *  /register to re-enter their number; recoverable, not blocking. */
export const REG_SESSION_PHONE_DIGITS_KEY = "nailiq-reg-phone-digits";

/**
 * Proof that phone OTP succeeded.
 * @deprecated Prefer the `?ct=…` URL param (written by `/register/verify`,
 * read by `/register/setup`). This sessionStorage key is kept as a
 * fallback for in-flight tabs that pre-date the URL-token migration; new
 * code paths should not read or write it.
 */
export const REG_COMPLETION_TOKEN_KEY = "nailiq-reg-completion-token";

/** `"1"` when this phone matched an existing salon before OTP send (Returning owner UX). */
export const REG_FLOW_OWNER_RETURNING = "nailiq-reg-owner-returning";

/**
 * `"1"` when `RegisterPageClient` just resent an OTP (i.e. `sendRegisterOtp`
 * succeeded and `REG_SESSION_PHONE_DIGITS_KEY` was already present). Read +
 * cleared by `VerifyPageClient` on mount to surface the "new code sent"
 * toast and reset its OTP boxes.
 */
export const REG_OTP_RESENT_FLAG = "nailiq-reg-otp-resent";
