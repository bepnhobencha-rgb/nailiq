"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isSuperAdmin } from "@/shared/lib/superadmin";
import {
  normalizeFeatureFlags,
  normalizePlanOverride,
  type LoadAllSalonsResult,
  type SuperAdminFeatureFlags,
  type SuperAdminSalonRow,
  type UpdateSalonFlagsInput,
  type UpdateSalonFlagsResult,
} from "@/shared/superadmin/superadminTypes";

/**
 * SuperAdmin server actions — all gated by an `isSuperAdmin(user.id)`
 * check up-front. RLS is a backstop; we enforce in code so a forgotten
 * policy can't leak the panel.
 *
 * NOTE: this file uses "use server" so it can ONLY export async
 * functions. Constants + types live in `./superadminTypes.ts`.
 */

type CallerContext = {
  userId: string;
  email: string | null;
};

async function requireSuperAdminCaller(): Promise<CallerContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const ok = await isSuperAdmin(user.id);
  if (!ok) return null;

  return {
    userId: user.id,
    email: typeof user.email === "string" ? user.email : null,
  };
}

export async function loadAllSalons(): Promise<LoadAllSalonsResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[superadmin/loadAllSalons] service role", e);
    return { ok: false, error: "server_error" };
  }

  // `subscription_plan`, `plan_override`, `feature_flags`, etc. aren't
  // in the auto-generated DB types yet — cast the select so .from()
  // doesn't yell.
  const { data, error } = (await admin
    .from("salons")
    .select(
      "id, slug, name, phone, subscription_plan, plan_override, feature_flags, is_beta, admin_notes, created_at" as never,
    )
    .order("created_at", { ascending: false })) as {
    data:
      | Array<{
          id: string;
          slug: string;
          name: string | null;
          phone: string | null;
          subscription_plan?: string | null;
          plan_override?: string | null;
          feature_flags?: unknown;
          is_beta?: boolean | null;
          admin_notes?: string | null;
          created_at?: string | null;
        }>
      | null;
    error: unknown;
  };

  if (error) {
    console.error("[superadmin/loadAllSalons] query", error);
    return { ok: false, error: "server_error" };
  }

  // Bookings-this-month per salon. Single query for the whole tenant
  // set — we count in JS rather than running N+1 per-salon queries
  // or pulling in pgcrypto. Excludes cancelled rows since they
  // represent voided traffic, not real demand.
  const monthStart = startOfCurrentUtcMonth();
  const { data: bookingsRows, error: bookingsErr } = (await admin
    .from("bookings")
    .select("salon_id" as never)
    .gte("start_time_utc", monthStart.toISOString())
    .neq("status", "cancelled")) as {
    data: Array<{ salon_id?: string | null }> | null;
    error: unknown;
  };

  if (bookingsErr) {
    // Don't fail the panel load over a count — log + continue with 0s.
    console.error("[superadmin/loadAllSalons] bookings count", bookingsErr);
  }

  const monthlyCounts = new Map<string, number>();
  for (const row of bookingsRows ?? []) {
    const salonId = row.salon_id == null ? "" : String(row.salon_id);
    if (!salonId) continue;
    monthlyCounts.set(salonId, (monthlyCounts.get(salonId) ?? 0) + 1);
  }

  const salons: SuperAdminSalonRow[] = (data ?? []).map((row) => {
    const id = String(row.id);
    return {
      id,
      slug: String(row.slug ?? ""),
      name: String(row.name ?? "").trim(),
      phone: String(row.phone ?? "").trim(),
      subscription_plan:
        typeof row.subscription_plan === "string"
          ? row.subscription_plan
          : null,
      plan_override: normalizePlanOverride(row.plan_override),
      feature_flags: normalizeFeatureFlags(row.feature_flags),
      is_beta: Boolean(row.is_beta),
      admin_notes:
        typeof row.admin_notes === "string" && row.admin_notes.trim().length > 0
          ? row.admin_notes
          : null,
      created_at: row.created_at ?? null,
      bookings_this_month: monthlyCounts.get(id) ?? 0,
    };
  });

  return { ok: true, salons };
}

function startOfCurrentUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function updateSalonFlags(
  salonId: string,
  patch: UpdateSalonFlagsInput,
): Promise<UpdateSalonFlagsResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  const id = salonId.trim();
  if (!id) return { ok: false, error: "invalid_payload" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[superadmin/updateSalonFlags] service role", e);
    return { ok: false, error: "server_error" };
  }

  // Fetch current row so we can merge feature_flags (UI sends a partial
  // patch). Also confirms the salon exists.
  const { data: existing, error: fetchErr } = (await admin
    .from("salons")
    .select("id, feature_flags" as never)
    .eq("id", id)
    .maybeSingle()) as {
    data: { id: string; feature_flags?: unknown } | null;
    error: unknown;
  };

  if (fetchErr) {
    console.error("[superadmin/updateSalonFlags] fetch", fetchErr);
    return { ok: false, error: "server_error" };
  }
  if (!existing?.id) {
    return { ok: false, error: "not_found" };
  }

  const update: Record<string, unknown> = {};

  if ("planOverride" in patch) {
    update.plan_override = normalizePlanOverride(patch.planOverride);
  }

  if ("isBeta" in patch && typeof patch.isBeta === "boolean") {
    update.is_beta = patch.isBeta;
  }

  if ("adminNotes" in patch) {
    const trimmed =
      typeof patch.adminNotes === "string" ? patch.adminNotes.trim() : "";
    update.admin_notes = trimmed.length > 0 ? trimmed : null;
  }

  if (patch.featureFlags) {
    const merged: SuperAdminFeatureFlags = {
      ...normalizeFeatureFlags(existing.feature_flags),
      ...normalizeFeatureFlags(patch.featureFlags),
    };
    update.feature_flags = merged;
  }

  if (Object.keys(update).length === 0) {
    return { ok: true };
  }

  const { error: upErr } = await admin
    .from("salons")
    .update(update as never)
    .eq("id", id);

  if (upErr) {
    console.error("[superadmin/updateSalonFlags] update", upErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true };
}
