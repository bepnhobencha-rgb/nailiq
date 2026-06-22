"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { sendEmailVerification } from "@/shared/dashboard/sendEmailVerification";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";

export type AddSalonEmailResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "invalid_email"
        | "unauthorized"
        | "server_error";
    };

export async function addSalonEmail(
  slug: string,
  email: string,
): Promise<AddSalonEmailResult> {
  const trimmed = email.trim();
  if (!trimmed || !isValidEmailFormat(trimmed)) {
    return { ok: false, error: "invalid_email" };
  }

  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) {
    return { ok: false, error: "unauthorized" };
  }
  // The salon's account/recovery email is owner-level config.
  if (!isOwnerOrAdmin(resolved.role)) {
    return { ok: false, error: "unauthorized" };
  }

  const { salon, kind } = resolved;

  if (kind === "demo_cookie") {
    let admin;
    try {
      admin = createServiceRoleClient();
    } catch {
      return { ok: false, error: "server_error" };
    }
    const { error } = await admin
      .from("salons")
      .update({ email: trimmed, email_verified: false })
      .eq("id", salon.id)
      .eq("slug", slug);
    if (error) {
      console.error("[addSalonEmail] demo update", error);
      return { ok: false, error: "server_error" };
    }
    // Best-effort verification send. The email is already saved (with
    // email_verified: false); a Resend miss/throw must not undo the
    // save — owners can resave to retry. The send helper logs its own
    // failures.
    void sendEmailVerification({
      salonId: salon.id,
      salonName: String(salon.name ?? slug),
      email: trimmed,
    });
    return { ok: true };
  }

  const supabase = await createClient();
  const { error: upErr } = await supabase
    .from("salons")
    .update({ email: trimmed, email_verified: false })
    .eq("id", salon.id)
    .eq("slug", slug);

  if (upErr) {
    console.error("[addSalonEmail] member update", upErr);
    return { ok: false, error: "server_error" };
  }

  // Best-effort send (see demo path above for rationale).
  void sendEmailVerification({
    salonId: salon.id,
    salonName: String(salon.name ?? slug),
    email: trimmed,
  });

  return { ok: true };
}

/**
 * Resend the verification email for the salon's current email address.
 * No-op if no email is set. Owner/admin only.
 */
export async function resendVerification(
  slug: string,
): Promise<{ ok: boolean; error?: string }> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved || !isOwnerOrAdmin(resolved.role)) {
    return { ok: false, error: "unauthorized" };
  }
  const { salon } = resolved;
  if (!salon.email) return { ok: false, error: "no_email" };

  await sendEmailVerification({
    salonId: salon.id,
    salonName: String(salon.name ?? slug),
    email: salon.email,
  });
  return { ok: true };
}
