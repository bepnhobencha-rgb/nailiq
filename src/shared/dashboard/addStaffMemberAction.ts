"use server";

import { revalidatePath } from "next/cache";
import { isOwner, isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";

interface AddStaffMemberInput {
  /** Slug of the salon to add the member to. The salon id is resolved
   *  server-side from this slug — never trusted from the client. */
  salonSlug: string;
  email?: string;
  phone?: string;
  role: SalonMemberRole;
}

type AddStaffMemberResult =
  | { success: true; userId: string; invited: boolean }
  | { success: false; error: string };

/** Roles an owner/admin may assign through this action. `owner` is set
 *  only at registration; `senior`/`nail_tech` belong to the staff-services
 *  flow, not the dashboard membership form. */
const ASSIGNABLE_ROLES: readonly SalonMemberRole[] = [
  "admin",
  "receptionist",
] as const;

async function findAuthUserIdByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<string | undefined> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) {
      console.error("[addStaffMemberAction] listUsers (email):", error);
      return undefined;
    }
    const hit = data.users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return undefined;
}

async function findAuthUserIdByPhone(
  admin: SupabaseClient,
  phone: string,
): Promise<string | undefined> {
  // Supabase stores phones in E.164; compare on digits only to be safe.
  const target = phone.replace(/[^\d]/g, "");
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) {
      console.error("[addStaffMemberAction] listUsers (phone):", error);
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

/**
 * Add a staff member (admin or receptionist) to a salon.
 *
 * Flow:
 *   1. Authorize the caller server-side via `getDashboardWriteClient`:
 *      must be `owner` or `admin` of the target salon. Only an `owner`
 *      may create another `admin` (prevents admin→admin escalation).
 *   2. Resolve the auth user:
 *      - email: reuse an existing auth user, otherwise `inviteUserByEmail`
 *        creates one and emails an invite. The link lands on `/auth/callback`,
 *        which exchanges the code and routes the member straight into their
 *        salon dashboard (already signed in).
 *      - phone: reuse an existing auth user, otherwise create one with
 *        `phone_confirm` so they can sign in via phone OTP.
 *   3. Upsert the `salon_members` row (idempotent on (salon_id, user_id),
 *      so re-adding simply updates the role).
 *
 * The previous implementation inserted a `randomUUID()` into
 * `salon_members.user_id`, which violates the FK to `auth.users(id)` —
 * the insert always failed in production.
 */
export async function addStaffMemberAction(
  input: AddStaffMemberInput,
): Promise<AddStaffMemberResult> {
  const { salonSlug, role } = input;
  const email = input.email?.trim() || undefined;
  const phone = input.phone?.trim() || undefined;

  if (!salonSlug) {
    return { success: false, error: "Salon is required" };
  }
  if (!email && !phone) {
    return { success: false, error: "Email or phone is required" };
  }
  if (!ASSIGNABLE_ROLES.includes(role)) {
    return { success: false, error: "Invalid role" };
  }

  // 1. Authorize the caller from their own session — the salon id comes
  //    from the resolved context, not from the client payload.
  const ctx = await getDashboardWriteClient(salonSlug);
  if (!ctx) {
    return { success: false, error: "Not authorized for this salon" };
  }
  if (!isOwnerOrAdmin(ctx.role)) {
    return { success: false, error: "Only an owner or admin can add staff" };
  }
  if (role === "admin" && !isOwner(ctx.role)) {
    return { success: false, error: "Only the owner can add an admin" };
  }

  const salonId = ctx.salon.id;

  let admin: SupabaseClient;
  try {
    admin = createServiceRoleClient();
  } catch {
    return {
      success: false,
      error: "Server is not configured for staff invites",
    };
  }

  // 2. Resolve or create the auth user.
  let userId: string | undefined;
  let invited = false;

  if (email) {
    userId = await findAuthUserIdByEmail(admin, email);
    if (!userId) {
      const siteUrl =
        process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXTAUTH_URL ?? "";
      const redirectTo = siteUrl
        ? `${siteUrl.replace(/\/$/, "")}/auth/callback`
        : undefined;
      const { data, error } = await admin.auth.admin.inviteUserByEmail(
        email,
        redirectTo ? { redirectTo } : undefined,
      );
      if (error || !data?.user?.id) {
        // Race / "already registered": fall back to a lookup.
        const found = await findAuthUserIdByEmail(admin, email);
        if (!found) {
          console.error("[addStaffMemberAction] invite failed:", error);
          return {
            success: false,
            error: error?.message ?? "Failed to invite staff member",
          };
        }
        userId = found;
      } else {
        userId = data.user.id;
        invited = true;
      }
    }
  } else if (phone) {
    userId = await findAuthUserIdByPhone(admin, phone);
    if (!userId) {
      const { data, error } = await admin.auth.admin.createUser({
        phone,
        phone_confirm: true,
      });
      if (error || !data?.user?.id) {
        console.error("[addStaffMemberAction] createUser(phone):", error);
        return {
          success: false,
          error: error?.message ?? "Failed to create staff member",
        };
      }
      userId = data.user.id;
      invited = true;
    }
  }

  if (!userId) {
    return { success: false, error: "Could not resolve the staff user" };
  }

  // 3. Idempotent membership write (unique on salon_id + user_id).
  const { error: memErr } = await admin.from("salon_members").upsert(
    { salon_id: salonId, user_id: userId, role },
    { onConflict: "salon_id,user_id" },
  );
  if (memErr) {
    console.error("[addStaffMemberAction] membership upsert:", memErr);
    return { success: false, error: memErr.message };
  }

  revalidatePath(`/dashboard/${salonSlug}/settings/staff`);

  return { success: true, userId, invited };
}
