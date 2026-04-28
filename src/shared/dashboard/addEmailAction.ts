"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
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
    // TODO Phase 2: Send verification email via Resend
    // await sendVerificationEmail(email, slug)
    // Will implement when Resend API key is available.
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

  // TODO Phase 2: Send verification email via Resend
  // await sendVerificationEmail(email, slug)
  // Will implement when Resend API key is available.

  return { ok: true };
}
