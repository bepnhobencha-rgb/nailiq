"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { getSiteUrl } from "@/shared/seo/site";
import { revalidatePath } from "next/cache";

// ── Types ─────────────────────────────────────────────────────────────────────

export type InviteTokenResult =
  | { ok: true; token: string; url: string; expiresAt: string }
  | { ok: false; error: string };

export type InviteTokenInfo = {
  valid: true;
  token: string;
  salonName: string;
  salonSlug: string;
  staffName: string;
  role: "admin" | "receptionist";
  expiresAt: string;
} | {
  valid: false;
  reason: "not_found" | "expired" | "used";
};

export type ClaimInviteTokenResult =
  | { ok: true; slug: string; role: string }
  | { ok: false; error: string };

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Owner/admin creates a QR invite token for an existing staff member.
 * Returns the raw token + full invite URL to render as QR + copy link.
 */
export async function createInviteToken(
  slug: string,
  staffId: string,
  role: "admin" | "receptionist",
): Promise<InviteTokenResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "Not authorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "Only owner or admin can invite" };
  if (role === "admin" && ctx.role !== "owner") {
    return { ok: false, error: "Only the owner can grant admin access" };
  }

  const admin = createServiceRoleClient();

  // Verify the staff row belongs to this salon.
  const { data: staff } = await admin
    .from("staff")
    .select("id, name")
    .eq("id", staffId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (!staff) return { ok: false, error: "Staff member not found" };

  const { data, error } = await admin
    .from("salon_invite_tokens")
    .insert({
      salon_id: ctx.salon.id,
      staff_id: staffId,
      role,
      created_by: ctx.userId ?? undefined,
    })
    .select("token, expires_at")
    .single();

  if (error || !data) {
    console.error("[createInviteToken]", error);
    return { ok: false, error: "Could not create invite token" };
  }

  const url = `${getSiteUrl()}/join/${data.token}`;
  return { ok: true, token: data.token, url, expiresAt: data.expires_at };
}

// ── Validate (public — no auth required) ─────────────────────────────────────

/**
 * Validates an invite token and returns display info for the /join page.
 * Uses service role because anon users can't read this table (RLS blocks all).
 */
export async function validateInviteToken(token: string): Promise<InviteTokenInfo> {
  const admin = createServiceRoleClient();

  const { data } = await admin
    .from("salon_invite_tokens")
    .select(`
      token, role, expires_at, used_at,
      staff:staff_id ( name ),
      salon:salon_id ( name, slug )
    `)
    .eq("token", token)
    .maybeSingle();

  if (!data) return { valid: false, reason: "not_found" };
  if (data.used_at) return { valid: false, reason: "used" };
  if (new Date(data.expires_at) < new Date()) return { valid: false, reason: "expired" };

  const staff = Array.isArray(data.staff) ? data.staff[0] : data.staff;
  const salon = Array.isArray(data.salon) ? data.salon[0] : data.salon;

  return {
    valid: true,
    token: data.token,
    salonName: (salon as { name: string })?.name ?? "NailIQ Salon",
    salonSlug: (salon as { slug: string })?.slug ?? "",
    staffName: (staff as { name: string })?.name ?? "",
    role: data.role as "admin" | "receptionist",
    expiresAt: data.expires_at,
  };
}

// ── Claim (called from /auth/callback after sign-in) ─────────────────────────

/**
 * Claims a valid invite token for the signed-in user:
 * 1. Validates token (not expired, not used)
 * 2. Upserts salon_members row
 * 3. Links staff.user_id (if not already linked to someone else)
 * 4. Marks token as used
 */
export async function claimInviteToken(
  token: string,
  userId: string,
): Promise<ClaimInviteTokenResult> {
  const admin = createServiceRoleClient();

  const { data: row } = await admin
    .from("salon_invite_tokens")
    .select("id, salon_id, staff_id, role, expires_at, used_at, salon:salon_id(slug)")
    .eq("token", token)
    .maybeSingle();

  if (!row) return { ok: false, error: "Token not found" };
  if (row.used_at) return { ok: false, error: "Token already used" };
  if (new Date(row.expires_at) < new Date()) return { ok: false, error: "Token expired" };

  const salon = Array.isArray(row.salon) ? row.salon[0] : row.salon;
  const slug = (salon as { slug: string })?.slug ?? "";

  // Upsert membership — if user already has a row in this salon, leave role as-is
  // (they may already be an owner). Only set if no existing row.
  const { data: existing } = await admin
    .from("salon_members")
    .select("role")
    .eq("salon_id", row.salon_id)
    .eq("user_id", userId)
    .maybeSingle();

  if (!existing) {
    const { error: memErr } = await admin.from("salon_members").insert({
      salon_id: row.salon_id,
      user_id: userId,
      role: row.role,
    });
    if (memErr) {
      console.error("[claimInviteToken] membership insert:", memErr);
      return { ok: false, error: memErr.message };
    }
  }

  // Link staff.user_id if not already claimed by someone else.
  const { data: staffRow } = await admin
    .from("staff")
    .select("user_id")
    .eq("id", row.staff_id)
    .maybeSingle();

  if (staffRow && !staffRow.user_id) {
    await admin
      .from("staff")
      .update({ user_id: userId })
      .eq("id", row.staff_id);
  }

  // Mark as used.
  await admin
    .from("salon_invite_tokens")
    .update({ used_at: new Date().toISOString(), used_by_user_id: userId })
    .eq("id", row.id);

  revalidatePath(`/dashboard/${slug}/setup/staff`);
  return { ok: true, slug, role: existing?.role ?? row.role };
}
