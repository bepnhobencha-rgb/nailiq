/** Transient phone digits between /register → /verify (sessionStorage only). */
export const REG_SESSION_PHONE_DIGITS_KEY = "nailiq-reg-phone-digits";

/** Proof that phone OTP succeeded — stored after verify for both demo and production (sessionStorage). */
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
