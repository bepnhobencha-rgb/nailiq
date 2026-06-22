"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

/**
 * Save the Yelp Business ID used by the AI Yelp Review Responder.
 * This is the slug in the Yelp URL: yelp.com/biz/{yelp_business_id}
 * e.g. "hi-lite-head-spa-anaheim"
 */
export async function updateYelpBusinessId(
  slug: string,
  yelpId: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = yelpId.trim().toLowerCase();

  if (trimmed !== "" && trimmed.length < 3) {
    return { ok: false, error: "Yelp Business ID không hợp lệ" };
  }

  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "Không tìm thấy salon" };
  if (!isOwnerOrAdmin(ctx.role))
    return { ok: false, error: "Chỉ chủ salon hoặc admin mới có thể thay đổi" };

  const { error } = await ctx.supabase
    .from("salons" as never)
    .update({ yelp_business_id: trimmed || null } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[updateYelpBusinessId]", error);
    return { ok: false, error: "Lưu thất bại" };
  }

  return { ok: true };
}
