import { cookies } from "next/headers";
import {
  IMPERSONATION_MAX_DURATION_MS,
  type ImpersonationMeta,
  type StashedFounderSession,
} from "@/shared/superadmin/impersonationTypes";

/**
 * Cookie helpers for the impersonation foundation (Phase 1E).
 *
 * Two cookies cooperate:
 *   - `nq-imp-meta` — non-secret metadata (salon + owner identifiers,
 *     timestamps, founder-supplied reason). Drives banner render and
 *     the audit row written on exit.
 *   - `nq-imp-original` — founder's Supabase access + refresh tokens,
 *     stashed BEFORE the session swap so `endImpersonation` can
 *     restore the original session without forcing a re-login. Same
 *     30-min lifetime as the meta cookie.
 *
 * Both cookies are httpOnly + sameSite=lax + secure-in-prod. The
 * original-session cookie holds real Supabase JWTs but they are
 * already self-signed; the cookie envelope adds standard XSS
 * protection. Encryption (e.g. iron-session) is intentionally out
 * of scope for V1 — revisit if SOC2 audit requires it.
 */

export const IMP_META_COOKIE = "nq-imp-meta";
export const IMP_ORIGINAL_COOKIE = "nq-imp-original";

const COOKIE_MAX_AGE_S = Math.floor(IMPERSONATION_MAX_DURATION_MS / 1000);

function baseCookieOpts() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
  };
}

/* ───────────────── meta ───────────────── */

export async function getImpersonationMeta(): Promise<ImpersonationMeta | null> {
  const store = await cookies();
  const raw = store.get(IMP_META_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ImpersonationMeta;
    // Sanity: required string fields. Missing → treat as absent.
    if (
      typeof parsed.founderUserId !== "string" ||
      typeof parsed.salonId !== "string" ||
      typeof parsed.ownerUserId !== "string" ||
      typeof parsed.expiresAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function setImpersonationMeta(meta: ImpersonationMeta) {
  const store = await cookies();
  store.set(IMP_META_COOKIE, JSON.stringify(meta), baseCookieOpts());
}

export async function clearImpersonationMeta() {
  const store = await cookies();
  store.set(IMP_META_COOKIE, "", { ...baseCookieOpts(), maxAge: 0 });
}

/* ──────────── stashed founder session ──────────── */

export async function stashFounderSession(session: StashedFounderSession) {
  const store = await cookies();
  store.set(IMP_ORIGINAL_COOKIE, JSON.stringify(session), baseCookieOpts());
}

export async function popFounderSession(): Promise<StashedFounderSession | null> {
  const store = await cookies();
  const raw = store.get(IMP_ORIGINAL_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StashedFounderSession;
    if (
      typeof parsed.access !== "string" ||
      typeof parsed.refresh !== "string"
    ) {
      return null;
    }
    // Clear immediately — single-use stash.
    store.set(IMP_ORIGINAL_COOKIE, "", { ...baseCookieOpts(), maxAge: 0 });
    return parsed;
  } catch {
    return null;
  }
}

export async function clearFounderSessionStash() {
  const store = await cookies();
  store.set(IMP_ORIGINAL_COOKIE, "", { ...baseCookieOpts(), maxAge: 0 });
}

/* ─────────────── expiry check ─────────────── */

export function isImpersonationExpired(meta: ImpersonationMeta): boolean {
  const expiresAt = new Date(meta.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return true;
  return expiresAt.getTime() <= Date.now();
}
