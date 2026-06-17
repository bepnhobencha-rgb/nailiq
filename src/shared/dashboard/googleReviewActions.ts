"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

/**
 * Update the Google Maps review URL for a salon.
 * Owner-only. URL must be empty or start with https://.
 */
export async function updateGoogleReviewUrl(
  slug: string,
  url: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = url.trim();

  if (trimmed !== "" && !trimmed.startsWith("https://")) {
    return { ok: false, error: "URL phải bắt đầu bằng https://" };
  }

  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "Không tìm thấy salon" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "Chỉ chủ salon hoặc admin mới có thể thay đổi" };

  const { error } = await ctx.supabase
    .from("salons" as never)
    .update({ google_review_url: trimmed || null } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[updateGoogleReviewUrl]", error);
    return { ok: false, error: "Lưu thất bại" };
  }

  return { ok: true };
}

/**
 * Save the Google Place ID used by the AI Review Responder to poll reviews.
 * Format: starts with "ChIJ" (standard Google Place IDs) or empty to clear.
 */
export async function updateGooglePlaceId(
  slug: string,
  placeId: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = placeId.trim();

  if (trimmed !== "" && trimmed.length < 5) {
    return { ok: false, error: "Place ID không hợp lệ" };
  }

  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "Không tìm thấy salon" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "Chỉ chủ salon hoặc admin mới có thể thay đổi" };

  const { error } = await ctx.supabase
    .from("salons" as never)
    .update({ google_place_id: trimmed || null } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[updateGooglePlaceId]", error);
    return { ok: false, error: "Lưu thất bại" };
  }

  return { ok: true };
}

export async function getGooglePlaceId(
  slug: string,
): Promise<{ placeId: string | null }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { placeId: null };

  const { data } = await ctx.supabase
    .from("salons" as never)
    .select("google_place_id" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();

  return { placeId: (data as { google_place_id?: string | null } | null)?.google_place_id ?? null };
}
