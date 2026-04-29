/** Transient phone digits between /register → /verify (sessionStorage only). */
export const REG_SESSION_PHONE_DIGITS_KEY = "nailiq-reg-phone-digits";

/** Proof that phone OTP succeeded — stored after verify for both demo and production (sessionStorage). */
export const REG_COMPLETION_TOKEN_KEY = "nailiq-reg-completion-token";

/** `"1"` when this phone matched an existing salon before OTP send (Returning owner UX). */
export const REG_FLOW_OWNER_RETURNING = "nailiq-reg-owner-returning";
