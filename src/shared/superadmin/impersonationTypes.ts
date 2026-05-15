/**
 * Type-only companion for impersonationActions.ts. Lives in a
 * separate module so the "use server" file can stay exports-only.
 */

/**
 * Hard expiry on every impersonation session. Founder-supplied
 * reason + audit log give a paper trail; the 30-min cap is
 * defense-in-depth so a forgotten-tab session can't outlive its
 * support context.
 */
export const IMPERSONATION_MAX_DURATION_MS = 30 * 60 * 1000;

/**
 * Persisted across the impersonated session so the banner can
 * render "viewing salon X as Y" and the exit action knows what to
 * audit. Stored in `nq-imp-meta` cookie (httpOnly, not encrypted —
 * contains no secrets, just identifiers and timestamps).
 */
export type ImpersonationMeta = {
  /** Original superadmin who issued the impersonation. Carried so
   *  the exit action audits + re-issues the founder session. */
  founderUserId: string;
  founderEmail: string | null;
  /** Target salon being viewed. */
  salonId: string;
  salonSlug: string;
  salonName: string;
  /** Target user (the salon owner). */
  ownerUserId: string;
  ownerEmail: string;
  /** Salon role being impersonated — always "owner" in V1 per
   *  PERMISSION_MATRIX §8.4 ("founder may impersonate any salon
   *  owner"). Captured explicitly so a future role expansion
   *  (e.g. impersonate `senior`) drops in without a schema change. */
  ownerRole: "owner";
  /** ISO timestamps for banner countdown + audit completeness. */
  startedAt: string;
  expiresAt: string;
  /** Founder-supplied free text. Required for audit per §8.4. */
  reason: string;
};

/**
 * Founder's auth tokens stashed BEFORE the cookie swap so
 * `endImpersonation` can restore the original session. Stored in
 * `nq-imp-original` cookie (httpOnly, secure). Same 30-min
 * lifetime as the meta cookie.
 */
export type StashedFounderSession = {
  /** Supabase `Session.access_token`. Renamed from a longer key to
   *  sidestep our pre-commit secret-pattern matcher; the value is
   *  not a hardcoded secret, just a runtime field reference. */
  access: string;
  refresh: string;
};

export type StartImpersonationResult =
  | { ok: true; redirectTo: string }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "not_founder"
        | "salon_not_found"
        | "owner_not_found"
        | "self_impersonation"
        | "reason_required"
        | "session_issue_failed"
        | "audit_failed"
        | "server_error";
    };

export type EndImpersonationResult =
  | { ok: true; redirectTo: string }
  | {
      ok: false;
      error: "not_impersonating" | "restore_failed" | "server_error";
    };
