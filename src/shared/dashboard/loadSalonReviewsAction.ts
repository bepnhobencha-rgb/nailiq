"use server";

import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { isOwner } from "@/shared/lib/salonMemberRole";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type SalonReviewRow = {
  id: string;
  rating: number | null;
  message: string | null;
  clientPhone: string | null;
  submittedAt: string | null;
  staffName: string | null;
  serviceName: string | null;
};

export type LoadSalonReviewsResult =
  | { ok: true; rows: SalonReviewRow[] }
  | {
      ok: false;
      error: "unauthorized" | "forbidden" | "feature_not_enabled" | "server_error";
    };

const PAGE_SIZE = 50;

/**
 * Owner-only list of submitted reviews for this salon. Includes only
 * rows where `submitted_at IS NOT NULL`; pending-but-not-submitted
 * rows live but are hidden until the customer submits.
 */
export async function loadSalonReviews(
  slug: string,
): Promise<LoadSalonReviewsResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (!isOwner(resolved.role)) return { ok: false, error: "forbidden" };

  // Release flag `reviews` (Beta, plan-sourced, default OFF). Refuse the
  // load even though nav/route gating hides the surface (defense-in-depth).
  // `resolved.salon` already carries subscription_plan/plan_override/
  // feature_flags, so the plan-aware resolver returns OFF for Base salons.
  if (!isReleaseFeatureEnabled(resolved.salon, "reviews")) {
    return { ok: false, error: "feature_not_enabled" };
  }

  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("reviews")
    .select(
      `
      id, rating, message, client_phone, submitted_at,
      services ( name ),
      staff ( name )
    `,
    )
    .eq("salon_id", resolved.salon.id)
    .not("submitted_at", "is", null)
    .order("submitted_at", { ascending: false })
    .limit(PAGE_SIZE);

  if (error) {
    console.error("[loadSalonReviews] query", error);
    return { ok: false, error: "server_error" };
  }

  type Joined = { name: string | null };
  const rows: SalonReviewRow[] = (data ?? []).map((r) => {
    const svcRaw = (r as { services?: Joined | Joined[] | null }).services;
    const staffRaw = (r as { staff?: Joined | Joined[] | null }).staff;
    const svc: Joined | null = Array.isArray(svcRaw)
      ? (svcRaw[0] ?? null)
      : (svcRaw ?? null);
    const stf: Joined | null = Array.isArray(staffRaw)
      ? (staffRaw[0] ?? null)
      : (staffRaw ?? null);
    return {
      id: String((r as { id: string }).id),
      rating:
        typeof (r as { rating?: unknown }).rating === "number"
          ? Number((r as { rating: number }).rating)
          : null,
      message:
        typeof (r as { message?: unknown }).message === "string"
          ? String((r as { message: string }).message)
          : null,
      clientPhone:
        typeof (r as { client_phone?: unknown }).client_phone === "string"
          ? String((r as { client_phone: string }).client_phone)
          : null,
      submittedAt:
        typeof (r as { submitted_at?: unknown }).submitted_at === "string"
          ? String((r as { submitted_at: string }).submitted_at)
          : null,
      staffName: stf?.name ?? null,
      serviceName: svc?.name ?? null,
    };
  });

  return { ok: true, rows };
}
