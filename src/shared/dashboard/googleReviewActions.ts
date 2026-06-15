"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwner } from "@/shared/lib/salonMemberRole";

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
  if (!isOwner(ctx.role)) return { ok: false, error: "Chỉ chủ salon mới có thể thay đổi" };

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
