"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwner } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { revalidatePath } from "next/cache";
import { sanitizeHex, DEFAULT_DRC_BG } from "@/shared/lib/drcTheme";

/**
 * Save the owner's chosen DRC accent color to salons.feature_flags.
 * Pass null to reset to the default NailIQ gold.
 * Owner-only — receptionist/nail_tech cannot change salon chrome.
 */
export async function saveDrcAccentColor(
  slug: string,
  accentHex: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwner(ctx.role)) return { ok: false, error: "unauthorized" };

  const clean = accentHex ? sanitizeHex(accentHex) : null;
  if (accentHex && !clean) return { ok: false, error: "invalid_color" };

  const supabase = createServiceRoleClient();

  const { data: salon } = await supabase
    .from("salons")
    .select("feature_flags")
    .eq("id", ctx.salon.id)
    .maybeSingle();

  const currentFlags =
    ((salon as { feature_flags?: Record<string, unknown> | null } | null)
      ?.feature_flags) ?? {};

  const newFlags = clean
    ? { ...currentFlags, drc_accent_color: clean }
    : Object.fromEntries(
        Object.entries(currentFlags).filter(([k]) => k !== "drc_accent_color"),
      );

  const { error } = await supabase
    .from("salons")
    .update({ feature_flags: newFlags } as never)
    .eq("id", ctx.salon.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/${slug}/center`);
  return { ok: true };
}

/**
 * Save the owner's chosen DRC background color to salons.feature_flags.
 * Pass null to reset to NailIQ default charcoal.
 * Owner-only.
 */
export async function saveDrcBgColor(
  slug: string,
  bgHex: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwner(ctx.role)) return { ok: false, error: "unauthorized" };

  const clean = bgHex ? sanitizeHex(bgHex) : null;
  if (bgHex && !clean) return { ok: false, error: "invalid_color" };

  const supabase = createServiceRoleClient();

  const { data: salon } = await supabase
    .from("salons")
    .select("feature_flags")
    .eq("id", ctx.salon.id)
    .maybeSingle();

  const currentFlags =
    ((salon as { feature_flags?: Record<string, unknown> | null } | null)
      ?.feature_flags) ?? {};

  const isDefault = !clean || clean === DEFAULT_DRC_BG;
  const newFlags = isDefault
    ? Object.fromEntries(
        Object.entries(currentFlags).filter(([k]) => k !== "drc_bg_color"),
      )
    : { ...currentFlags, drc_bg_color: clean };

  const { error } = await supabase
    .from("salons")
    .update({ feature_flags: newFlags } as never)
    .eq("id", ctx.salon.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/${slug}/center`);
  return { ok: true };
}
