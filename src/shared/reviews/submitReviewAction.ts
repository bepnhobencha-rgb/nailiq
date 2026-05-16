"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Submit a review via the public form. Authenticated by `token` only
 * — no salon-side auth, since this is the customer's link.
 *
 * Idempotent on `submitted_at`: a second submit on the same token is
 * rejected so customers can't grief by re-submitting different
 * ratings. The token survives so the owner sees the original
 * submission timestamp.
 */
export type SubmitReviewResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "not_found"
        | "already_submitted"
        | "invalid_rating"
        | "server_error";
    };

export async function submitReviewAction(
  token: string,
  rating: number,
  message: string,
): Promise<SubmitReviewResult> {
  const t = (token ?? "").trim();
  if (!t) return { ok: false, error: "not_found" };

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: "invalid_rating" };
  }

  const trimmedMessage = (message ?? "").trim().slice(0, 2000);

  try {
    const supabase = createServiceRoleClient();

    const { data: row, error: fetchErr } = await supabase
      .from("reviews")
      .select("id, submitted_at")
      .eq("request_token", t)
      .maybeSingle();
    if (fetchErr) {
      console.error("[submitReview] fetch", fetchErr);
      return { ok: false, error: "server_error" };
    }
    if (!row?.id) return { ok: false, error: "not_found" };
    if ((row as { submitted_at?: string | null }).submitted_at) {
      return { ok: false, error: "already_submitted" };
    }

    const { error: upErr } = await supabase
      .from("reviews")
      .update({
        rating,
        message: trimmedMessage.length > 0 ? trimmedMessage : null,
        submitted_at: new Date().toISOString(),
      } as never)
      .eq("id", (row as { id: string }).id);

    if (upErr) {
      console.error("[submitReview] update", upErr);
      return { ok: false, error: "server_error" };
    }
    return { ok: true };
  } catch (e) {
    console.error("[submitReview] unexpected", e);
    return { ok: false, error: "server_error" };
  }
}
