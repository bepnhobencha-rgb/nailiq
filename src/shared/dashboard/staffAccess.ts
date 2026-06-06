"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { addStaff, getDashboardWriteClient } from "@/shared/dashboard/setupActions";

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

const ASSIGNABLE: readonly StaffAccessRole[] = ["admin", "receptionist"] as const;

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
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    return { ok: false, error: "Only an owner or admin can manage access" };
  }
  return { ok: true, ctx };
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
 * Map staff.user_id → access info (role, email/phone, active) for the staff
 * members that actually have a linked login (`linkedUserIds`).
 *
 * Uses the service-role client because `salon_members` RLS only lets a user
 * read their OWN row — an owner could not otherwise see the whole team.
 *
 * Cost scales with the salon's linked-team size, NOT the project's total user
 * count: roles come from one indexed `IN (...)` query, and each user's
 * email/status is fetched with a targeted `getUserById` in parallel. A salon
 * with no logins yet makes ZERO Auth calls. (The previous version paged
 * through *every* auth user in the project — up to 4,000 rows — on each render.)
 */
export async function loadTeamAccessMap(
  salonId: string,
  linkedUserIds: string[],
): Promise<Record<string, StaffAccessInfo>> {
  const ids = Array.from(new Set(linkedUserIds.filter(Boolean)));
  if (ids.length === 0) return {};

  let admin: SupabaseClient;
  try {
    admin = createServiceRoleClient();
  } catch {
    return {};
  }

  // Roles for just the linked users — single indexed query.
  const { data: members } = await admin
    .from("salon_members")
    .select("user_id, role")
    .eq("salon_id", salonId)
    .in("user_id", ids);

  const roleByUser = new Map<string, StaffAccessInfo["role"]>();
  for (const m of (members ?? []) as { user_id: string; role: string }[]) {
    if (m.role === "owner" || m.role === "admin" || m.role === "receptionist") {
      roleByUser.set(m.user_id, m.role);
    }
  }
  if (roleByUser.size === 0) return {};

  // Email + confirmation status: one targeted lookup per linked user, in
  // parallel. No full-project scan.
  const entries = await Promise.all(
    Array.from(roleByUser.entries()).map(async ([userId, role]) => {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      const u = error ? null : data.user;
      const info: StaffAccessInfo = {
        role,
        email: u?.email ?? null,
        phone: u?.phone ?? null,
        active: Boolean(
          u?.email_confirmed_at || u?.phone_confirmed_at || u?.last_sign_in_at,
        ),
      };
      return [userId, info] as const;
    }),
  );

  return Object.fromEntries(entries);
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
  if (input.role === "admin" && ctx.role !== "owner") {
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
  | { ok: true; invited?: boolean; staffCreated: boolean }
  | { ok: false; error: string; staffCreated: boolean };

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
    return { ok: true, staffCreated: true };
  }

  const res = await inviteStaffAccess(slug, created.id ?? "", {
    email: input.email,
    role: input.accessRole ?? "receptionist",
  });
  if (!res.ok) {
    // The staff row exists; only the login step failed — surface both facts so
    // the UI can say "member added, but the invite didn't send".
    return { ok: false, error: res.error, staffCreated: true };
  }
  return { ok: true, invited: res.invited, staffCreated: true };
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
  if (role === "admin" && ctx.role !== "owner") {
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
