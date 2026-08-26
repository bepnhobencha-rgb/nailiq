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
  | { ok: false; error: "unauthorized" };

/** Is there a VERIFIED TOTP factor on this superadmin account? */
export async function getMfaStatus(): Promise<MfaStatus> {
  const supabase = await requireSuperadmin();
  if (!supabase) return { ok: false, error: "unauthorized" };
  const { data } = await supabase.auth.mfa.listFactors();
  const verified = (data?.totp ?? []).find((f) => f.status === "verified");
  return { ok: true, enrolled: Boolean(verified), factorId: verified?.id ?? null };
}

export type StartEnrollResult =
  | { ok: true; factorId: string; qrSvg: string; secret: string }
  | { ok: false; error: "unauthorized" | "enroll_failed" };

/**
 * Begin TOTP enrollment — returns a QR (SVG) + the manual secret. Cleans up any
 * leftover UNVERIFIED factors first so re-enrolling stays tidy.
 */
export async function startMfaEnroll(): Promise<StartEnrollResult> {
  const supabase = await requireSuperadmin();
  if (!supabase) return { ok: false, error: "unauthorized" };

  const { data: list } = await supabase.auth.mfa.listFactors();
  for (const f of list?.totp ?? []) {
    if (f.status !== "verified") {
      await supabase.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `superadmin-${Date.now()}`,
  });
  if (error || !data) return { ok: false, error: "enroll_failed" };
  return {
    ok: true,
    factorId: data.id,
    qrSvg: data.totp.qr_code,
    secret: data.totp.secret,
  };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; error: "unauthorized" | "invalid_code" };

/** Confirm the enrollment by verifying a code from the authenticator app. */
export async function verifyMfaEnroll(
  factorId: string,
  code: string,
): Promise<VerifyResult> {
  const supabase = await requireSuperadmin();
  if (!supabase) return { ok: false, error: "unauthorized" };
  const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({
    factorId,
  });
  if (chErr || !ch) return { ok: false, error: "invalid_code" };
  const { error } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: ch.id,
    code: code.trim(),
  });
  return error ? { ok: false, error: "invalid_code" } : { ok: true };
}

/** Remove the factor (turn 2FA off). */
export async function unenrollMfa(factorId: string): Promise<VerifyResult> {
  const supabase = await requireSuperadmin();
  if (!supabase) return { ok: false, error: "unauthorized" };
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  return error ? { ok: false, error: "invalid_code" } : { ok: true };
}

/**
 * Login gate: verify a TOTP code to upgrade this session from aal1 → aal2.
 * Resolves the factor server-side (the page only sends the code).
 */
export async function verifyMfaChallenge(code: string): Promise<VerifyResult> {
  const supabase = await requireSuperadmin();
  if (!supabase) return { ok: false, error: "unauthorized" };
  const { data: list } = await supabase.auth.mfa.listFactors();
  const factor = (list?.totp ?? []).find((f) => f.status === "verified");
  if (!factor) return { ok: false, error: "invalid_code" };
  const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({
    factorId: factor.id,
  });
  if (chErr || !ch) return { ok: false, error: "invalid_code" };
  const { error } = await supabase.auth.mfa.verify({
    factorId: factor.id,
    challengeId: ch.id,
    code: code.trim(),
  });
  return error ? { ok: false, error: "invalid_code" } : { ok: true };
}
