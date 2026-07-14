import { randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";

import { assertNotProductionFromEnv } from "./guardProduction";

/**
 * SuperAdmin E2E helpers.
 *
 * Fills the gap called out in `e2e/superadmin/audit-logs.spec.ts`: until
 * now there was no way to drive an authenticated superadmin surface in
 * Playwright. This module seeds a real superadmin (auth user + a row in
 * `public.superadmins`), drives the email/password UI login, and exposes
 * service-role readers for `platform_flags` + `superadmin_audit_logs` so
 * specs can assert the persisted side-effects of a SuperAdmin action.
 *
 * Seeding goes through the service-role client (same pattern as
 * `e2e/helpers/db.ts`) because both tables are service-role-only on the
 * write side — there is no public registration for operators.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl?.trim() || !serviceKey?.trim()) {
  throw new Error(
    "e2e/helpers/superadmin requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.test.local)",
  );
}

// Second line of defence. globalSetup already ran this, but this module holds a
// service-role client that creates privileged accounts — it must refuse to load
// against production even if someone imports it outside the Playwright runner.
assertNotProductionFromEnv();

const supabase = createClient(supabaseUrl, serviceKey);

/**
 * A fresh, strong, single-use password. Never a constant: the previous
 * hardcoded default sat in a PUBLIC repo (and in git history from commit
 * 316a61f onward), which meant every superadmin the suite created shared one
 * publicly-readable password. Treat that old value as permanently compromised.
 *
 * The password lives only in memory for the life of the run and is returned to
 * the caller so it can drive the login form. It is never logged, never written
 * to an artifact, and never interpolated into an error message.
 */
function freshPassword(): string {
  // 32 random bytes, base64url → ~43 chars, plus a fixed suffix so the value
  // always satisfies any upper/lower/digit/symbol policy.
  return `${randomBytes(32).toString("base64url")}#Aa1`;
}

/** Platform-scoped roles, mirrors `SuperAdminRole` in src/shared/lib/superadmin.ts. */
export type SuperAdminRole =
  | "founder"
  | "ops_admin"
  | "support_admin"
  | "billing_admin"
  | "ai_admin"
  | "readonly_analyst";

export type SeededSuperAdmin = {
  userId: string;
  email: string;
  password: string;
  role: SuperAdminRole;
};

/**
 * Create an auth user with a password AND an active `superadmins` row.
 *
 * `email_confirm: true` so the password sign-in works without a real mailbox.
 *
 * Role defaults to the LEAST-privileged role. It used to default to `founder`,
 * so any spec that forgot to think about privilege silently minted a
 * full-access platform operator. Specs that genuinely need `founder` pass it
 * explicitly (all three current call sites already do).
 *
 * The email always carries the `e2e-` prefix and the `.test.invalid` domain
 * (a reserved TLD per RFC 2606 — no human can ever own one). That marker is
 * what `sweep()` keys on, and it is the only condition under which cleanup is
 * allowed to delete an account.
 */
export async function seedTestSuperadmin(opts?: {
  email?: string;
  password?: string;
  role?: SuperAdminRole;
}): Promise<SeededSuperAdmin> {
  const email =
    opts?.email ?? `e2e-superadmin-${randomUUID()}@nailiq.test.invalid`;
  const password = opts?.password ?? freshPassword();
  const role: SuperAdminRole = opts?.role ?? "readonly_analyst";

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user?.id) {
    throw new Error(
      error?.message ?? "seedTestSuperadmin: failed to create auth user",
    );
  }
  const userId = data.user.id;

  // revoked_at defaults to NULL → active. created_by is nullable.
  const { error: insErr } = await supabase
    .from("superadmins")
    .insert({ user_id: userId, role } as never);
  if (insErr) {
    // Roll back the auth user so a failed seed doesn't leave an orphan.
    await supabase.auth.admin.deleteUser(userId);
    throw new Error(`seedTestSuperadmin: failed to insert superadmins row: ${insErr.message}`);
  }

  return { userId, email, password, role };
}

/** Remove the superadmins row, every audit row this actor wrote, and the auth user. */
export async function cleanupTestSuperadmin(userId: string) {
  // Audit logs are append-only for authenticated clients, but the
  // service-role client bypasses RLS — clean up the rows this seeded
  // actor produced so repeated runs don't accumulate noise.
  await supabase.from("superadmin_audit_logs").delete().eq("actor_user_id", userId);
  await supabase.from("superadmins").delete().eq("user_id", userId);
  await supabase.auth.admin.deleteUser(userId);
}

/**
 * Drive the email/password UI login at `/superadmin/login` and wait
 * until the shell renders. Uses the real form (not a cookie shortcut)
 * so the server-side role gate + session cookie wiring are exercised.
 */
export async function loginAsSuperadmin(
  page: Page,
  account: { email: string; password: string },
) {
  await page.goto("/superadmin/login");
  const form = page.getByTestId("superadmin-login-form");
  await expect(form).toBeVisible();
  await form.locator('input[type="email"]').fill(account.email);
  await form.locator('input[type="password"]').fill(account.password);
  await form.getByRole("button", { name: "Sign in" }).click();
  // The form does router.replace("/superadmin"); wait until we leave login.
  await page.waitForURL(/\/superadmin(?!\/login)(\/|$)/, { timeout: 30_000 });
}

/* ───────────────────────── service-role readers ───────────────────────── */

export type PlatformFlagRow = {
  key: string;
  enabled: boolean;
  updated_by: string | null;
  updated_at: string | null;
};

/** Read a single `platform_flags` row (null if it doesn't exist yet). */
export async function getPlatformFlag(
  key: string,
): Promise<PlatformFlagRow | null> {
  const { data } = await supabase
    .from("platform_flags")
    .select("key, enabled, updated_by, updated_at")
    .eq("key", key)
    .maybeSingle();
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    key: String(row.key),
    enabled: row.enabled === true,
    updated_by: typeof row.updated_by === "string" ? row.updated_by : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

/**
 * Force a `platform_flags` row to a known state so a spec starts from a
 * deterministic baseline regardless of what prior runs (or other
 * environments) left behind. Mirrors the action's upsert shape.
 */
export async function setPlatformFlag(key: string, enabled: boolean) {
  await supabase
    .from("platform_flags")
    .upsert(
      { key, enabled, updated_at: new Date().toISOString() } as never,
      { onConflict: "key" } as never,
    );
}

export type AuditLogRow = {
  id: string;
  actor_user_id: string | null;
  actor_role: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  before_jsonb: Record<string, unknown> | null;
  after_jsonb: Record<string, unknown> | null;
  created_at: string;
};

/**
 * Newest audit row matching the given filters, or null. Filters are
 * ANDed; omit any to widen the search. Ordered by created_at desc so a
 * spec can assert on the entry its action just produced.
 */
export async function getLatestAuditLog(filters: {
  actorUserId?: string;
  action?: string;
  targetKind?: string;
  targetId?: string;
}): Promise<AuditLogRow | null> {
  let query = supabase
    .from("superadmin_audit_logs")
    .select(
      "id, actor_user_id, actor_role, action, target_kind, target_id, before_jsonb, after_jsonb, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(1);

  if (filters.actorUserId) query = query.eq("actor_user_id", filters.actorUserId);
  if (filters.action) query = query.eq("action", filters.action);
  if (filters.targetKind) query = query.eq("target_kind", filters.targetKind);
  if (filters.targetId) query = query.eq("target_id", filters.targetId);

  const { data } = await query.maybeSingle();
  return (data as AuditLogRow | null) ?? null;
}

/** Count audit rows matching filters — handy for "exactly N events written" assertions. */
export async function countAuditLogs(filters: {
  actorUserId?: string;
  action?: string;
}): Promise<number> {
  let query = supabase
    .from("superadmin_audit_logs")
    .select("id", { count: "exact", head: true });
  if (filters.actorUserId) query = query.eq("actor_user_id", filters.actorUserId);
  if (filters.action) query = query.eq("action", filters.action);
  const { count } = await query;
  return count ?? 0;
}
