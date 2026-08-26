"use server";

import { revalidatePath } from "next/cache";
import {
  isOwner,
  isOwnerOrAdmin,
  normalizeSalonMemberRole,
  type SalonMemberRole,
} from "@/shared/lib/salonMemberRole";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { addStaff, getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { requireActiveAuthSession } from "@/shared/auth/requireActiveAuthSession";

/**
 * Login/permission roles for a team member's optional dashboard account.
 * These live in `salon_members.role`. `owner` is created at registration
 * and is managed/guarded specially (never created or revoked here).
 */
export type StaffAccessRole = "admin" | "receptionist";

/** What the Team page shows about a person's login account. */
export interface StaffAccessInfo {
  /** salon_members.role, or "owner" for the salon owner. */
  role: StaffAccessRole | "owner";
  email: string | null;
  phone: string | null;
  /** false = invited but hasn't confirmed email / signed in yet. */
  active: boolean;
}

export type StaffAccessResult =
  | { ok: true; invited?: boolean }
  | { ok: false; error: string };

export type TeamAccessMapResult =
  | { ok: true; accessMap: Record<string, StaffAccessInfo> }
  | {
      ok: false;
      error: "invalid_slug" | "unauthorized" | "forbidden" | "server_error";
    };

const ASSIGNABLE: readonly StaffAccessRole[] = ["admin", "receptionist"] as const;
const SALON_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Auth-user lookup helpers ────────────────────────────────────────────────

async function findUserIdByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<string | undefined> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) {
      console.error("[staffAccess] listUsers(email):", error);
      return undefined;
    }
    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return undefined;
}

async function findUserIdByPhone(
  admin: SupabaseClient,
  phone: string,
): Promise<string | undefined> {
  const target = phone.replace(/[^\d]/g, "");
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) {
      console.error("[staffAccess] listUsers(phone):", error);
      return undefined;
    }
    const hit = data.users.find(
      (u) => (u.phone ?? "").replace(/[^\d]/g, "") === target,
    );
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return undefined;
}

/** Reuse an existing auth user or create one (email → invite, phone → create). */
async function resolveOrInviteUser(
  admin: SupabaseClient,
  input: { email?: string; phone?: string },
): Promise<{ userId?: string; invited: boolean; error?: string }> {
  const email = input.email?.trim() || undefined;
  const phone = input.phone?.trim() || undefined;

  if (email) {
    const existing = await findUserIdByEmail(admin, email);
    if (existing) return { userId: existing, invited: false };

    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXTAUTH_URL ?? "";
    // Invite link lands on /auth/callback → exchanges the code and routes the
    // member straight into their salon dashboard (they're already signed in).
    // (Not /auth/recovery, which forced a confusing "set password + sign out".)
    const redirectTo = siteUrl
      ? `${siteUrl.replace(/\/$/, "")}/auth/callback`
      : undefined;
    const { data, error } = await admin.auth.admin.inviteUserByEmail(
      email,
      redirectTo ? { redirectTo } : undefined,
    );
    if (error || !data?.user?.id) {
      const found = await findUserIdByEmail(admin, email);
      if (found) return { userId: found, invited: false };
      console.error("[staffAccess] invite failed:", error);
      return { invited: false, error: error?.message ?? "invite_failed" };
    }
    return { userId: data.user.id, invited: true };
  }

  if (phone) {
    const existing = await findUserIdByPhone(admin, phone);
    if (existing) return { userId: existing, invited: false };

    const { data, error } = await admin.auth.admin.createUser({
      phone,
      phone_confirm: true,
    });
    if (error || !data?.user?.id) {
      console.error("[staffAccess] createUser(phone):", error);
      return { invited: false, error: error?.message ?? "create_failed" };
    }
    return { userId: data.user.id, invited: true };
  }

  return { invited: false, error: "email_or_phone_required" };
}

// ── Authorization ───────────────────────────────────────────────────────────

type AuthorizedCtx = Awaited<ReturnType<typeof getDashboardWriteClient>>;

async function authorize(
  slug: string,
): Promise<{ ok: true; ctx: NonNullable<AuthorizedCtx> } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "Not authorized for this salon" };
  if (!isOwnerOrAdmin(ctx.role)) {
    return { ok: false, error: "Only an owner or admin can manage access" };
  }
  return { ok: true, ctx };
}

type AuthorizedTeamRead = {
  salonId: string;
  role: SalonMemberRole;
  supabase: Awaited<ReturnType<typeof createClient>>;
};

/**
 * Authorize the PII-bearing team-access read without using service role.
 *
 * This deliberately does not reuse `resolveSalonForDashboard`: that resolver
 * supports a demo-cookie fallback backed by service role. A public Server
 * Function that returns Auth email/phone data must require a freshly verified
 * Supabase user plus an owner/admin membership in the exact slug instead.
 */
async function authorizeTeamAccessRead(
  slug: string,
): Promise<
  | { ok: true; auth: AuthorizedTeamRead }
  | { ok: false; error: "unauthorized" | "forbidden" | "server_error" }
> {
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch (error) {
    console.error("[loadTeamAccessMap] create server client", error);
    return { ok: false, error: "server_error" };
  }

  const session = await requireActiveAuthSession(supabase);
  if (!session.ok) {
    return {
      ok: false,
      error:
        session.code === "auth_unavailable" ? "server_error" : "unauthorized",
    };
  }
  const user = session.user;

  const { data: memberships, error: membershipError } = await supabase
    .from("salon_members")
    .select("salon_id, role")
    .eq("user_id", user.id);
  if (membershipError) {
    console.error("[loadTeamAccessMap] memberships", membershipError);
    return { ok: false, error: "server_error" };
  }
  if (!memberships?.length) return { ok: false, error: "unauthorized" };

  const salonIds = memberships.map((membership) => String(membership.salon_id));
  const { data: salon, error: salonError } = await supabase
    .from("salons")
    .select("id, slug")
    .eq("slug", slug)
    .in("id", salonIds)
    .maybeSingle();
  if (salonError) {
    console.error("[loadTeamAccessMap] salon", salonError);
    return { ok: false, error: "server_error" };
  }
  if (!salon?.id) return { ok: false, error: "unauthorized" };

  const membership = memberships.find(
    (candidate) => String(candidate.salon_id) === String(salon.id),
  );
  if (!membership) return { ok: false, error: "unauthorized" };

  const role = normalizeSalonMemberRole(membership.role);
  if (!isOwnerOrAdmin(role)) return { ok: false, error: "forbidden" };

  return {
    ok: true,
    auth: { salonId: String(salon.id), role, supabase },
  };
}

/** Load a `staff` row scoped to the salon (service-role; caller already authorized). */
async function loadStaffRow(
  admin: SupabaseClient,
  salonId: string,
  staffId: string,
): Promise<{ id: string; user_id: string | null } | null> {
  const { data } = await admin
    .from("staff")
    .select("id, user_id")
    .eq("id", staffId)
    .eq("salon_id", salonId)
    .maybeSingle();
  return (data as { id: string; user_id: string | null } | null) ?? null;
}

// ── Data loader for the Team page ───────────────────────────────────────────

/**
 * Map staff.user_id → access info (role, email/phone, active) for the
 * authenticated owner/admin's salon.
 *
 * The public Server Function accepts only the salon slug. It verifies the
 * caller's Auth user, tenant membership, and owner/admin role using the
 * request-scoped client before creating a service-role client. Linked user IDs
 * are derived from canonical `staff` rows; caller-supplied salon/user IDs are
 * never accepted.
 *
 * After authorization, service role is required because `salon_members` RLS
 * exposes only the caller's own row and Auth admin owns email/phone metadata.
 * Every DB/Auth error fails the whole read closed; no partial PII map is
 * returned.
 */
export async function loadTeamAccessMap(
  slug: string,
): Promise<TeamAccessMapResult> {
  if (
    typeof slug !== "string" ||
    slug.length === 0 ||
    slug.length > 100 ||
    !SALON_SLUG_RE.test(slug)
  ) {
    return { ok: false, error: "invalid_slug" };
  }

  try {
    return await loadAuthorizedTeamAccessMap(slug);
  } catch (error) {
    // Supabase normally returns `{ error }`, but transport/runtime failures can
    // reject instead. Keep the public Server Function typed and fail closed in
    // both cases; never let a partial PII map escape.
    console.error("[loadTeamAccessMap] unexpected failure", error);
    return { ok: false, error: "server_error" };
  }
}

async function loadAuthorizedTeamAccessMap(
  slug: string,
): Promise<TeamAccessMapResult> {
  const authorization = await authorizeTeamAccessRead(slug);
  if (!authorization.ok) return authorization;
  const { salonId, supabase } = authorization.auth;

  const { data: staffRows, error: staffError } = await supabase
    .from("staff")
    .select("user_id")
    .eq("salon_id", salonId)
    .is("deleted_at" as never, null);
  if (staffError) {
    console.error("[loadTeamAccessMap] staff", staffError);
    return { ok: false, error: "server_error" };
  }

  const ids = Array.from(
    new Set(
      (staffRows ?? [])
        .map((row) => row.user_id)
        .filter((userId): userId is string =>
          typeof userId === "string" && userId.length > 0,
        ),
    ),
  );
  if (ids.length === 0) return { ok: true, accessMap: {} };

  let admin: SupabaseClient;
  try {
    admin = createServiceRoleClient();
  } catch (error) {
    console.error("[loadTeamAccessMap] create service client", error);
    return { ok: false, error: "server_error" };
  }

  // Roles for just the linked users — single indexed query.
  const { data: members, error: membersError } = await admin
    .from("salon_members")
    .select("user_id, role")
    .eq("salon_id", salonId)
    .in("user_id", ids);
  if (membersError) {
    console.error("[loadTeamAccessMap] linked memberships", membersError);
    return { ok: false, error: "server_error" };
  }

  const roleByUser = new Map<string, StaffAccessInfo["role"]>();
  for (const m of (members ?? []) as { user_id: string; role: string }[]) {
    if (m.role === "owner" || m.role === "admin" || m.role === "receptionist") {
      roleByUser.set(m.user_id, m.role);
    }
  }
  if (roleByUser.size === 0) return { ok: true, accessMap: {} };

  // Email + confirmation status: one targeted lookup per linked user, in
  // parallel. No full-project scan.
  try {
    const authUsers = await Promise.all(
      Array.from(roleByUser.keys()).map(async (userId) => {
        const { data, error } = await admin.auth.admin.getUserById(userId);
        return { userId, user: data.user, error };
      }),
    );
    if (authUsers.some(({ error, user }) => Boolean(error) || !user)) {
      console.error("[loadTeamAccessMap] Auth user lookup failed");
      return { ok: false, error: "server_error" };
    }

    const entries = authUsers.map(({ userId, user }) => {
      const info: StaffAccessInfo = {
        role: roleByUser.get(userId)!,
        email: user?.email ?? null,
        phone: user?.phone ?? null,
        active: Boolean(
          user?.email_confirmed_at ||
            user?.phone_confirmed_at ||
            user?.last_sign_in_at,
        ),
      };
      return [userId, info] as const;
    });

    return { ok: true, accessMap: Object.fromEntries(entries) };
  } catch (error) {
    console.error("[loadTeamAccessMap] Auth user lookup", error);
    return { ok: false, error: "server_error" };
  }
}

// ── Mutations ───────────────────────────────────────────────────────────────

/**
 * Grant dashboard access to an existing bookable staff member: create (or
 * reuse) an auth user, add the salon_members permission row, and link it to
 * the staff row via staff.user_id.
 */
export async function inviteStaffAccess(
  slug: string,
  staffId: string,
  input: { email?: string; phone?: string; role: StaffAccessRole },
): Promise<StaffAccessResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  if (!ASSIGNABLE.includes(input.role)) {
    return { ok: false, error: "Invalid role" };
  }
  // Only the owner may grant admin (prevents admin→admin escalation).
  if (input.role === "admin" && !isOwner(ctx.role)) {
    return { ok: false, error: "Only the owner can grant admin access" };
  }
  if (!input.email?.trim() && !input.phone?.trim()) {
    return { ok: false, error: "Email or phone is required" };
  }

  let admin: SupabaseClient;
  try {
    admin = createServiceRoleClient();
  } catch {
    return { ok: false, error: "Server is not configured for invites" };
  }

  const staff = await loadStaffRow(admin, ctx.salon.id, staffId);
  if (!staff) return { ok: false, error: "Staff member not found" };
  if (staff.user_id) {
    return { ok: false, error: "This member already has a login" };
  }

  const resolved = await resolveOrInviteUser(admin, {
    email: input.email,
    phone: input.phone,
  });
  if (!resolved.userId) {
    return { ok: false, error: resolved.error ?? "Could not resolve the user" };
  }

  // Guard: that login must not already be linked to another staff in the salon.
  const { data: clash } = await admin
    .from("staff")
    .select("id")
    .eq("salon_id", ctx.salon.id)
    .eq("user_id", resolved.userId)
    .maybeSingle();
  if (clash) {
    return { ok: false, error: "That account is already linked to another team member" };
  }

  const { error: memErr } = await admin.from("salon_members").upsert(
    { salon_id: ctx.salon.id, user_id: resolved.userId, role: input.role },
    { onConflict: "salon_id,user_id" },
  );
  if (memErr) {
    console.error("[inviteStaffAccess] membership upsert:", memErr);
    return { ok: false, error: memErr.message };
  }

  const { error: linkErr } = await admin
    .from("staff")
    .update({ user_id: resolved.userId })
    .eq("id", staffId)
    .eq("salon_id", ctx.salon.id);
  if (linkErr) {
    console.error("[inviteStaffAccess] link:", linkErr);
    return { ok: false, error: linkErr.message };
  }

  revalidatePath(`/dashboard/${slug}/setup/staff`);
  return { ok: true, invited: resolved.invited };
}

export type AddTeamMemberResult =
  | { ok: true; invited?: boolean; staffCreated: boolean; staffId?: string }
  | { ok: false; error: string; staffCreated: boolean; staffId?: string };

/**
 * All-in-one "Add team member": create the staff row and (optionally) grant a
 * login in a single call. This is the unified flow behind the Team page's
 * "Add member" sheet — it replaces the old add-staff → set-inactive → invite
 * dance and handles the "management-only admin" case cleanly:
 *
 *   takesBookings=false → staff row created with status "inactive" (kept out of
 *   the public booking flow) while still optionally getting a login.
 */
export async function addTeamMember(
  slug: string,
  input: {
    name: string;
    takesBookings: boolean;
    /** Provider role when takesBookings; ignored otherwise. */
    jobRole?: "senior" | "nail_tech";
    grantAccess: boolean;
    accessRole?: StaffAccessRole;
    email?: string;
  },
): Promise<AddTeamMemberResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name is required", staffCreated: false };
  if (input.grantAccess && !input.email?.trim()) {
    return {
      ok: false,
      error: "Email is required to grant a login",
      staffCreated: false,
    };
  }

  // A non-booking member still needs a valid job_role (the column is
  // provider-only); "nail_tech" + inactive keeps them out of booking.
  const jobRole = input.takesBookings ? (input.jobRole ?? "nail_tech") : "nail_tech";
  const status = input.takesBookings ? "active" : "inactive";

  const created = await addStaff(slug, { name, role: jobRole, status });
  if (!created.ok) {
    return { ok: false, error: created.error, staffCreated: false };
  }

  if (!input.grantAccess) {
    revalidatePath(`/dashboard/${slug}/setup/staff`);
    return { ok: true, staffCreated: true, staffId: created.id };
  }

  const res = await inviteStaffAccess(slug, created.id ?? "", {
    email: input.email,
    role: input.accessRole ?? "receptionist",
  });
  if (!res.ok) {
    // The staff row exists; only the login step failed — surface both facts so
    // the UI can say "member added, but the invite didn't send".
    return { ok: false, error: res.error, staffCreated: true, staffId: created.id };
  }
  return { ok: true, invited: res.invited, staffCreated: true, staffId: created.id };
}

/** Change an existing access role (admin ↔ receptionist). Owner role is immutable here. */
export async function changeStaffAccessRole(
  slug: string,
  staffId: string,
  role: StaffAccessRole,
): Promise<StaffAccessResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  if (!ASSIGNABLE.includes(role)) return { ok: false, error: "Invalid role" };
  if (role === "admin" && !isOwner(ctx.role)) {
    return { ok: false, error: "Only the owner can grant admin access" };
  }

  let admin: SupabaseClient;
  try {
    admin = createServiceRoleClient();
  } catch {
    return { ok: false, error: "Server is not configured" };
  }

  const staff = await loadStaffRow(admin, ctx.salon.id, staffId);
  if (!staff?.user_id) return { ok: false, error: "This member has no login" };

  const { data: current } = await admin
    .from("salon_members")
    .select("role")
    .eq("salon_id", ctx.salon.id)
    .eq("user_id", staff.user_id)
    .maybeSingle();
  if ((current as { role?: string } | null)?.role === "owner") {
    return { ok: false, error: "The owner's role cannot be changed here" };
  }

  const { error } = await admin
    .from("salon_members")
    .update({ role })
    .eq("salon_id", ctx.salon.id)
    .eq("user_id", staff.user_id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/${slug}/setup/staff`);
  return { ok: true };
}

/** Revoke dashboard access: remove the salon_members row and unlink staff.user_id. */
export async function revokeStaffAccess(
  slug: string,
  staffId: string,
): Promise<StaffAccessResult> {
  const auth = await authorize(slug);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { ctx } = auth;

  let admin: SupabaseClient;
  try {
    admin = createServiceRoleClient();
  } catch {
    return { ok: false, error: "Server is not configured" };
  }

  const staff = await loadStaffRow(admin, ctx.salon.id, staffId);
  if (!staff?.user_id) return { ok: false, error: "This member has no login" };

  const { data: current } = await admin
    .from("salon_members")
    .select("role")
    .eq("salon_id", ctx.salon.id)
    .eq("user_id", staff.user_id)
    .maybeSingle();
  if ((current as { role?: string } | null)?.role === "owner") {
    return { ok: false, error: "The owner's access cannot be revoked" };
  }

  const { error: delErr } = await admin
    .from("salon_members")
    .delete()
    .eq("salon_id", ctx.salon.id)
    .eq("user_id", staff.user_id);
  if (delErr) return { ok: false, error: delErr.message };

  const { error: unlinkErr } = await admin
    .from("staff")
    .update({ user_id: null })
    .eq("id", staffId)
    .eq("salon_id", ctx.salon.id);
  if (unlinkErr) return { ok: false, error: unlinkErr.message };

  revalidatePath(`/dashboard/${slug}/setup/staff`);
  return { ok: true };
}
