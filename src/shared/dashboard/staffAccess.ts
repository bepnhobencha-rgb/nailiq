"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";

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
    const redirectTo = siteUrl
      ? `${siteUrl.replace(/\/$/, "")}/auth/recovery`
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
 * Map staff.user_id → access info (role, email/phone, active). Uses the
 * service-role client because `salon_members` RLS only lets a user read
 * their OWN row — an owner could not otherwise list the whole team.
 */
export async function loadTeamAccessMap(
  salonId: string,
): Promise<Record<string, StaffAccessInfo>> {
  let admin: SupabaseClient;
  try {
    admin = createServiceRoleClient();
  } catch {
    return {};
  }

  const { data: members } = await admin
    .from("salon_members")
    .select("user_id, role")
    .eq("salon_id", salonId);

  const roleByUser = new Map<string, StaffAccessInfo["role"]>();
  for (const m of (members ?? []) as { user_id: string; role: string }[]) {
    if (m.role === "owner" || m.role === "admin" || m.role === "receptionist") {
      roleByUser.set(m.user_id, m.role);
    }
  }
  if (roleByUser.size === 0) return {};

  // Resolve emails / confirmation status for the linked users.
  const contactByUser = new Map<
    string,
    { email: string | null; phone: string | null; active: boolean }
  >();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) break;
    for (const u of data.users) {
      if (!roleByUser.has(u.id)) continue;
      contactByUser.set(u.id, {
        email: u.email ?? null,
        phone: u.phone ?? null,
        active: Boolean(u.email_confirmed_at || u.phone_confirmed_at || u.last_sign_in_at),
      });
    }
    if (data.users.length < 200) break;
  }

  const out: Record<string, StaffAccessInfo> = {};
  for (const [userId, role] of roleByUser) {
    const c = contactByUser.get(userId);
    out[userId] = {
      role,
      email: c?.email ?? null,
      phone: c?.phone ?? null,
      active: c?.active ?? false,
    };
  }
  return out;
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
