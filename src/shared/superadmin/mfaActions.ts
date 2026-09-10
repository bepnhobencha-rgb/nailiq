"use server";

import { requireActiveSuperAdminSession } from "@/shared/auth/requireActiveSuperAdminSession";

/**
 * TOTP two-factor for the superadmin panel — built on Supabase's native MFA.
 * SOFT by design: enrolling is opt-in and the login gate only triggers for a
 * superadmin who already has a VERIFIED factor (getAuthenticatorAssuranceLevel
 * → nextLevel 'aal2'). A superadmin who never enrolls is never prompted, so this
 * cannot lock anyone out. Recovery if an authenticator is lost: unenroll the
 * factor via the Supabase dashboard (Auth → Users → factors) or the admin API.
 *
 * Every action is gated to a superadmin caller; a non-superadmin gets a no-op.
 */

async function requireSuperadmin() {
  const access = await requireActiveSuperAdminSession();
  return access.ok ? access.supabase : null;
}

export type MfaStatus =
  | { ok: true; enrolled: boolean; factorId: string | null }
  | { ok: false; error: "unauthorized" | "load_failed" };

/** Is there a VERIFIED TOTP factor on this superadmin account? */
export async function getMfaStatus(): Promise<MfaStatus> {
  try {
    const supabase = await requireSuperadmin();
    if (!supabase) return { ok: false, error: "unauthorized" };
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error || !data) return { ok: false, error: "load_failed" };
    const verified = data.totp.find((f) => f.status === "verified");
    return { ok: true, enrolled: Boolean(verified), factorId: verified?.id ?? null };
  } catch {
    return { ok: false, error: "load_failed" };
  }
}

export type StartEnrollResult =
  | { ok: true; factorId: string; qrSvg: string; secret: string }
  | { ok: false; error: "unauthorized" | "enroll_failed" };

/**
 * Begin TOTP enrollment — returns a QR (SVG) + the manual secret. Cleans up any
 * leftover UNVERIFIED factors first so re-enrolling stays tidy.
 */
export async function startMfaEnroll(): Promise<StartEnrollResult> {
  try {
    const access = await requireActiveSuperAdminSession();
    if (!access.ok) return {
      ok: false, error: access.code === "auth_unavailable" ? "enroll_failed" : "unauthorized",
    };
    const { supabase } = access;
    const { data: list, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError || !list) return { ok: false, error: "enroll_failed" };
    // The SDK's type-specific lists contain VERIFIED factors only. Pending
    // enrollments live in `all`; leave other factor types and verified TOTP intact.
    for (const f of list.all) {
      if (f.factor_type === "totp" && f.status === "unverified") {
        const { data, error } = await supabase.auth.mfa.unenroll({ factorId: f.id });
        // Do not create another secret after an unconfirmed cleanup.
        if (error || !data) return { ok: false, error: "enroll_failed" };
      }
    }
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `superadmin-${Date.now()}`,
    });
    if (error || !data) return { ok: false, error: "enroll_failed" };
    return { ok: true, factorId: data.id, qrSvg: data.totp.qr_code, secret: data.totp.secret };
  } catch {
    return { ok: false, error: "enroll_failed" };
  }
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; error: "unauthorized" | "invalid_code" };

type EnrollmentVerifyResult = VerifyResult | { ok: false; error: "verification_unavailable" };

/** Confirm the enrollment by verifying a code from the authenticator app. */
export async function verifyMfaEnroll(
  factorId: string,
  code: string,
): Promise<EnrollmentVerifyResult> {
  try {
    const access = await requireActiveSuperAdminSession();
    if (!access.ok) return {
      ok: false, error: access.code === "auth_unavailable" ? "verification_unavailable" : "unauthorized",
    };
    const normalized = code.trim();
    if (!factorId || !/^\d{6}$/.test(normalized)) return { ok: false, error: "invalid_code" };
    const { supabase } = access;
    const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
    if (chErr || !ch) return { ok: false, error: "verification_unavailable" };
    const { data, error } = await supabase.auth.mfa.verify({ factorId, challengeId: ch.id, code: normalized });
    if (error) return {
      ok: false,
      error: error.code === "mfa_verification_failed" || error.code === "mfa_challenge_expired"
        ? "invalid_code" : "verification_unavailable",
    };
    return data ? { ok: true } : { ok: false, error: "verification_unavailable" };
  } catch {
    return { ok: false, error: "verification_unavailable" };
  }
}

/** Remove the factor (turn 2FA off). An unavailable result requires a status read. */
export async function unenrollMfa(factorId: string): Promise<
  { ok: true } | { ok: false; error: "unauthorized" | "unenroll_failed" }
> {
  try {
    const access = await requireActiveSuperAdminSession();
    if (!access.ok) return {
      ok: false, error: access.code === "auth_unavailable" ? "unenroll_failed" : "unauthorized",
    };
    if (!factorId) return { ok: false, error: "unenroll_failed" };
    const { data, error } = await access.supabase.auth.mfa.unenroll({ factorId });
    return error || !data ? { ok: false, error: "unenroll_failed" } : { ok: true };
  } catch {
    return { ok: false, error: "unenroll_failed" };
  }
}

/**
 * Login gate: verify a TOTP code to upgrade this session from aal1 → aal2.
 * Resolves the factor server-side (the page only sends the code).
 */
export async function verifyMfaChallenge(code: string): Promise<
  VerifyResult | { ok: false; error: "verification_unavailable" }
> {
  try {
    const access = await requireActiveSuperAdminSession();
    if (!access.ok) return {
      ok: false,
      error: access.code === "auth_unavailable" ? "verification_unavailable" : "unauthorized",
    };
    const normalized = code.trim();
    if (!/^\d{6}$/.test(normalized)) return { ok: false, error: "invalid_code" };
    const { supabase } = access;
    const { data: list, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError || !list) return { ok: false, error: "verification_unavailable" };
    const factor = list.totp.find((f) => f.status === "verified");
    if (!factor) return { ok: false, error: "invalid_code" };
    const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: factor.id });
    if (chErr || !ch) return { ok: false, error: "verification_unavailable" };
    const { data, error } = await supabase.auth.mfa.verify({
      factorId: factor.id,
      challengeId: ch.id,
      code: normalized,
    });
    if (error) return {
      ok: false,
      error: error.code === "mfa_verification_failed" || error.code === "mfa_challenge_expired"
        ? "invalid_code" : "verification_unavailable",
    };
    return data ? { ok: true } : { ok: false, error: "verification_unavailable" };
  } catch {
    // A lost response does not establish whether verification took effect.
    // Keep the form recoverable without exposing provider details or retrying.
    return { ok: false, error: "verification_unavailable" };
  }
}
