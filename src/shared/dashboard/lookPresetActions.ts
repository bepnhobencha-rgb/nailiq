"use server";

import { getLookPreset } from "@/shared/verticals/lookPresets";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

export type ApplyLookPresetResult =
  | { ok: true; presetId: string }
  | { ok: false; error: "unauthorized" | "forbidden" | "invalid_preset" | "server_error" };

/**
 * Owner-only: apply a designed "look" to the public booking page. Writes the
 * preset's brand colour, light/dark theme, and imagery onto the salon — the
 * booking page reads those, so the whole page transforms at once. Scoped to the
 * salon's vertical so e.g. a head spa can only apply head-spa looks.
 */
export async function applyLookPreset(
  slug: string,
  presetId: string,
): Promise<ApplyLookPresetResult> {
  const { getDashboardWriteClient } = await import(
    "@/shared/dashboard/setupActions"
  );
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  // Resolve the salon's vertical to scope the preset.
  const { data: vrow } = await ctx.supabase
    .from("salons")
    .select("vertical")
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const vertical = (vrow as { vertical?: string | null } | null)?.vertical ?? null;

  const preset = getLookPreset(vertical, presetId);
  if (!preset) return { ok: false, error: "invalid_preset" };

  const { error } = await ctx.supabase
    .from("salons")
    .update({
      brand_color: preset.brandColor,
      theme_mode: preset.themeMode,
      booking_images: preset.imagery,
    } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[applyLookPreset]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true, presetId: preset.id };
}
