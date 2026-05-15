"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import {
  clearFounderSessionStash,
  clearImpersonationMeta,
  getImpersonationMeta,
  popFounderSession,
  setImpersonationMeta,
  stashFounderSession,
} from "@/shared/superadmin/impersonationCookies";
import {
  IMPERSONATION_MAX_DURATION_MS,
  type EndImpersonationResult,
  type ImpersonationMeta,
  type StartImpersonationResult,
} from "@/shared/superadmin/impersonationTypes";

/**
 * Impersonation foundation (Phase 1E).
 *
 * Per `docs/PERMISSION_MATRIX.md` §8.4 — server-side cookie swap
 * only, real Supabase session for the target owner (no fake JWT
 * mint), audit row on every enter/exit transition, founder-only.
 *
 * Session swap mechanism: `admin.generateLink({type: 'magiclink'})`
 * returns a `hashed_token` for the target user. Calling
 * `verifyOtp({token_hash, type: 'magiclink'})` from the SSR client
 * exchanges it for a real Session, which the SSR client then
 * persists as the auth cookies (replacing the founder's). The
 * receptionist + dashboard surfaces see a real owner session — RLS
 * and all client-side membership lookups continue to work
 * unmodified.
 *
 * The founder's previous access + refresh tokens are stashed in
 * `nq-imp-original` BEFORE the swap so `endImpersonation` can
 * restore the original session via `setSession`. Both cookies
 * carry a 30-min lifetime matching the hard expiry per §8.4.
 */

const AUDIT_KIND_SALON = "salon";

type AuditWrite = {
  actorUserId: string;
  actorRole: string;
  action: "impersonate_enter" | "impersonate_exit" | "impersonate_expire";
  salonId: string;
  reason: string | null;
  beforeJsonb?: Record<string, unknown> | null;
  afterJsonb?: Record<string, unknown> | null;
};

async function writeAudit(write: AuditWrite): Promise<boolean> {
  try {
    const admin = createServiceRoleClient();
    const { error } = await admin.from("superadmin_audit_logs").insert(
      {
        actor_user_id: write.actorUserId,
        actor_role: write.actorRole,
        action: write.action,
        target_kind: AUDIT_KIND_SALON,
        target_id: write.salonId,
        before_jsonb: write.beforeJsonb ?? null,
        after_jsonb: write.afterJsonb ?? null,
        reason: write.reason,
      } as never,
    );
    if (error) {
      console.error("[impersonation/audit] insert", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[impersonation/audit] unexpected", e);
    return false;
  }
}

/**
 * Founder-only entry point. Validates inputs + role + target,
 * writes the `impersonate_enter` audit row BEFORE the cookie
 * swap (so a swap failure can't strand a row in unknown state),
 * stashes the founder's tokens, then swaps to the owner session.
 *
 * Returns the dashboard URL the caller should navigate to.
 * Throws via Next.js redirect on success to avoid client-side
 * routing fragility with cookie-mutating responses.
 */
export async function startImpersonation(
  salonId: string,
  reason: string,
): Promise<StartImpersonationResult> {
  const trimmedReason = (reason ?? "").trim();
  if (trimmedReason.length === 0) {
    return { ok: false, error: "reason_required" };
  }

  const founderSupabase = await createClient();
  const {
    data: { user: founderUser },
  } = await founderSupabase.auth.getUser();
  if (!founderUser) return { ok: false, error: "unauthorized" };

  const founderRole = await getSuperAdminRole(founderUser.id);
  if (founderRole !== "founder") {
    return { ok: false, error: "not_founder" };
  }

  const id = (salonId ?? "").trim();
  if (!id) return { ok: false, error: "salon_not_found" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[impersonation/start] service role", e);
    return { ok: false, error: "server_error" };
  }

  // 1. Resolve target salon + owner. Per PERMISSION_MATRIX §8.4
  //    only `salon_members.role = 'owner'` is impersonable in V1.
  const salonRes = (await admin
    .from("salons")
    .select("id, slug, name" as never)
    .eq("id", id)
    .maybeSingle()) as {
    data: { id: string; slug: string; name: string | null } | null;
    error: unknown;
  };
  if (salonRes.error || !salonRes.data) {
    return { ok: false, error: "salon_not_found" };
  }

  const memberRes = (await admin
    .from("salon_members")
    .select("user_id, role, created_at" as never)
    .eq("salon_id", id)
    .eq("role", "owner")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()) as {
    data: { user_id: string; role: string } | null;
    error: unknown;
  };
  if (memberRes.error || !memberRes.data?.user_id) {
    return { ok: false, error: "owner_not_found" };
  }
  const ownerUserId = memberRes.data.user_id;

  if (ownerUserId === founderUser.id) {
    return { ok: false, error: "self_impersonation" };
  }

  const ownerUserRes = await admin.auth.admin.getUserById(ownerUserId);
  if (ownerUserRes.error || !ownerUserRes.data.user?.email) {
    console.error(
      "[impersonation/start] owner email lookup",
      ownerUserRes.error,
    );
    return { ok: false, error: "owner_not_found" };
  }
  const ownerEmail = ownerUserRes.data.user.email;

  // 2. Stash founder tokens BEFORE swap.
  const founderSessionRes = await founderSupabase.auth.getSession();
  const founderSession = founderSessionRes.data.session;
  if (!founderSession?.access_token || !founderSession?.refresh_token) {
    return { ok: false, error: "session_issue_failed" };
  }

  // 3. Mint a real Supabase session for the owner via magiclink +
  //    verifyOtp. We use admin.generateLink to obtain the
  //    `hashed_token`, then verifyOtp on the SSR client to consume
  //    it — that path is what supabase-ssr drives via its cookie
  //    handlers, so the new session lands as proper auth cookies.
  const linkRes = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: ownerEmail,
  });
  const hashedToken =
    (linkRes.data?.properties as { hashed_token?: string } | undefined)
      ?.hashed_token ?? null;
  if (linkRes.error || !hashedToken) {
    console.error("[impersonation/start] generateLink", linkRes.error);
    return { ok: false, error: "session_issue_failed" };
  }

  // 4. Build meta + write audit row BEFORE the cookie swap so an
  //    audit insert failure aborts cleanly without stranding a
  //    half-swapped state.
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + IMPERSONATION_MAX_DURATION_MS);
  const meta: ImpersonationMeta = {
    founderUserId: founderUser.id,
    founderEmail: founderUser.email ?? null,
    salonId: salonRes.data.id,
    salonSlug: salonRes.data.slug,
    salonName: (salonRes.data.name ?? "").trim() || salonRes.data.slug,
    ownerUserId,
    ownerEmail,
    ownerRole: "owner",
    startedAt: startedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    reason: trimmedReason,
  };

  const audited = await writeAudit({
    actorUserId: founderUser.id,
    actorRole: "founder",
    action: "impersonate_enter",
    salonId: meta.salonId,
    reason: trimmedReason,
    afterJsonb: {
      owner_user_id: ownerUserId,
      owner_role: "owner",
      started_at: meta.startedAt,
      expires_at: meta.expiresAt,
      salon_slug: meta.salonSlug,
    },
  });
  if (!audited) {
    return { ok: false, error: "audit_failed" };
  }

  // 5. Stash + swap.
  await stashFounderSession({
    access: founderSession.access_token,
    refresh: founderSession.refresh_token,
  });

  const verifyRes = await founderSupabase.auth.verifyOtp({
    token_hash: hashedToken,
    type: "magiclink",
  });
  if (verifyRes.error || !verifyRes.data.session) {
    console.error("[impersonation/start] verifyOtp", verifyRes.error);
    // Roll back the stash so we don't leak founder tokens with no
    // way to consume them.
    await clearFounderSessionStash();
    return { ok: false, error: "session_issue_failed" };
  }

  await setImpersonationMeta(meta);

  return {
    ok: true,
    redirectTo: `/dashboard/${encodeURIComponent(meta.salonSlug)}`,
  };
}

/**
 * Exits the impersonation: restores the founder session, writes
 * the `impersonate_exit` audit row, clears cookies, and returns
 * the URL to redirect back to (the salon detail page where the
 * impersonation started).
 */
export async function endImpersonation(): Promise<EndImpersonationResult> {
  const meta = await getImpersonationMeta();
  if (!meta) return { ok: false, error: "not_impersonating" };

  const stash = await popFounderSession();
  if (!stash) {
    // No way to restore — the founder will need to /superadmin/login
    // again. Still write the exit audit so the trail closes.
    await writeAudit({
      actorUserId: meta.founderUserId,
      actorRole: "founder",
      action: "impersonate_exit",
      salonId: meta.salonId,
      reason: "(no stash — session restore unavailable)",
      afterJsonb: {
        ended_at: new Date().toISOString(),
        salon_slug: meta.salonSlug,
        clean_exit: false,
      },
    });
    await clearImpersonationMeta();
    return { ok: false, error: "restore_failed" };
  }

  const supabase = await createClient();
  const restoreRes = await supabase.auth.setSession({
    access_token: stash.access,
    refresh_token: stash.refresh,
  });
  if (restoreRes.error || !restoreRes.data.session) {
    console.error("[impersonation/end] setSession", restoreRes.error);
    // Write the audit row anyway — the trail must close even when
    // restore fails.
    await writeAudit({
      actorUserId: meta.founderUserId,
      actorRole: "founder",
      action: "impersonate_exit",
      salonId: meta.salonId,
      reason: meta.reason,
      afterJsonb: {
        ended_at: new Date().toISOString(),
        salon_slug: meta.salonSlug,
        clean_exit: false,
        restore_error: String(restoreRes.error?.message ?? "unknown"),
      },
    });
    await clearImpersonationMeta();
    return { ok: false, error: "restore_failed" };
  }

  await writeAudit({
    actorUserId: meta.founderUserId,
    actorRole: "founder",
    action: "impersonate_exit",
    salonId: meta.salonId,
    reason: meta.reason,
    afterJsonb: {
      ended_at: new Date().toISOString(),
      salon_slug: meta.salonSlug,
      clean_exit: true,
    },
  });

  await clearImpersonationMeta();

  return {
    ok: true,
    redirectTo: `/superadmin/salons/${encodeURIComponent(meta.salonId)}`,
  };
}

/**
 * Convenience action used by the dashboard layout: if an
 * impersonation meta cookie is present AND the timestamp says the
 * 30-min window has elapsed, force-end with an `impersonate_expire`
 * audit row. Caller redirects to /superadmin/login afterwards.
 */
export async function expireImpersonationIfStale(): Promise<boolean> {
  const meta = await getImpersonationMeta();
  if (!meta) return false;
  const expiresAt = new Date(meta.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return false;
  if (expiresAt.getTime() > Date.now()) return false;

  await writeAudit({
    actorUserId: meta.founderUserId,
    actorRole: "founder",
    action: "impersonate_expire",
    salonId: meta.salonId,
    reason: meta.reason,
    afterJsonb: {
      expired_at: new Date().toISOString(),
      salon_slug: meta.salonSlug,
    },
  });

  // Clear both cookies — the founder will need to sign in again.
  await clearImpersonationMeta();
  await clearFounderSessionStash();

  // Also clear the now-stale owner session so the next request
  // isn't authenticated as the owner.
  const supabase = await createClient();
  await supabase.auth.signOut();

  return true;
}

/**
 * Server-action wrapper used by the impersonation banner's Exit
 * button. Wraps `endImpersonation` with a redirect so the cookie
 * swap completes within the action's response.
 */
export async function endImpersonationAndRedirect(): Promise<void> {
  const result = await endImpersonation();
  if (result.ok) {
    redirect(result.redirectTo);
  } else {
    // Restore failed or no meta — send to superadmin login.
    redirect("/superadmin/login");
  }
}
