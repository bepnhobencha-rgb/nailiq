"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isSuperAdmin } from "@/shared/lib/superadmin";
import {
  isPlatformFlagKey,
  isRestorableTable,
  normalizeFeatureFlags,
  normalizePlanOverride,
  PLATFORM_FLAG_KEYS,
  SUPERADMIN_CATEGORY_SLUG_RE,
  type AddCategoryInput,
  type CategoryMutationResult,
  type DeletedRecord,
  type LoadAllCategoriesResult,
  type LoadAllSalonsResult,
  type LoadDeletedRecordsResult,
  type LoadPlatformFlagsResult,
  type PlatformFlag,
  type PlatformFlagKey,
  type RestorableTable,
  type RestoreSalonRecordResult,
  type SuperAdminCategoryRow,
  type SuperAdminFeatureFlags,
  type SuperAdminSalonRow,
  type UpdateCategoryInput,
  type UpdatePlatformFlagResult,
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

/**
 * Soft-deleted records for a salon (services + staff + client_profiles).
 * Used by the SuperAdmin "Show deleted" expander; pairs with
 * restoreSalonRecord to flip `deleted_at` back to NULL.
 */
export async function loadDeletedRecordsForSalon(
  salonId: string,
): Promise<LoadDeletedRecordsResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  const id = salonId.trim();
  if (!id) return { ok: true, records: [] };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[superadmin/loadDeletedRecords] service role", e);
    return { ok: false, error: "server_error" };
  }

  type Row = { id: string; deleted_at: string | null; label: string };
  const records: DeletedRecord[] = [];

  const services = (await admin
    .from("services")
    .select("id, name, deleted_at" as never)
    .eq("salon_id", id)
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false })) as {
    data: Array<{ id: string; name?: string | null; deleted_at?: string | null }> | null;
    error: unknown;
  };
  if (services.data) {
    for (const r of services.data) {
      records.push({
        id: String(r.id),
        table: "services",
        label: String(r.name ?? "(unnamed service)").trim() || "(unnamed service)",
        deleted_at: r.deleted_at ?? "",
      });
    }
  }

  const staff = (await admin
    .from("staff")
    .select("id, name, deleted_at" as never)
    .eq("salon_id", id)
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false })) as {
    data: Array<{ id: string; name?: string | null; deleted_at?: string | null }> | null;
    error: unknown;
  };
  if (staff.data) {
    for (const r of staff.data) {
      records.push({
        id: String(r.id),
        table: "staff",
        label: String(r.name ?? "(unnamed staff)").trim() || "(unnamed staff)",
        deleted_at: r.deleted_at ?? "",
      });
    }
  }

  // client_profiles is NOT salon-scoped on the row level (phone is the
  // PK), but typically a salon-scoped query is misleading. We skip per-
  // salon listing here and surface them via a future global panel.
  // Reserved: leaving the type union open via RESTORABLE_TABLES.
  void records;

  return { ok: true, records };
}

export async function restoreSalonRecord(
  table: string,
  recordId: string,
): Promise<RestoreSalonRecordResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  if (!isRestorableTable(table)) {
    return { ok: false, error: "invalid_payload" };
  }
  const id = recordId.trim();
  if (!id) return { ok: false, error: "invalid_payload" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[superadmin/restoreSalonRecord] service role", e);
    return { ok: false, error: "server_error" };
  }

  const t: RestorableTable = table;
  const { data, error } = (await admin
    .from(t)
    .update({ deleted_at: null } as never)
    .eq("id", id)
    .not("deleted_at", "is", null)
    .select("id")
    .maybeSingle()) as {
    data: { id?: string } | null;
    error: unknown;
  };

  if (error) {
    console.error("[superadmin/restoreSalonRecord] update", error);
    return { ok: false, error: "server_error" };
  }
  if (!data?.id) {
    return { ok: false, error: "not_found" };
  }

  return { ok: true };
}


/* ───────────────── Platform-wide flags (PR #108) ───────────────── */

/**
 * Load every row from `platform_flags`. The 5 seeded keys are
 * authoritative; any extra rows in the table are dropped. Returned
 * with descriptors merged so the UI can render label + badge without
 * a second round trip.
 */
export async function loadPlatformFlags(): Promise<LoadPlatformFlagsResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[superadmin/loadPlatformFlags] service role", e);
    return { ok: false, error: "server_error" };
  }

  const { data, error } = (await admin
    .from("platform_flags")
    .select("key, enabled, description, updated_at" as never)) as {
    data:
      | Array<{
          key: string;
          enabled?: boolean | null;
          description?: string | null;
          updated_at?: string | null;
        }>
      | null;
    error: unknown;
  };

  if (error) {
    console.error("[superadmin/loadPlatformFlags] query", error);
    return { ok: false, error: "server_error" };
  }

  type PlatformRow = NonNullable<typeof data>[number];
  const byKey = new Map<string, PlatformRow>();
  for (const r of data ?? []) {
    if (typeof r.key === "string") byKey.set(r.key, r);
  }

  // Materialize a row for every known key — surfaces newly-added flags
  // even when the migration seed didn't run on this environment.
  const flags: PlatformFlag[] = PLATFORM_FLAG_KEYS.map((key) => {
    const row = byKey.get(key);
    return {
      key,
      enabled: row?.enabled === true,
      description: typeof row?.description === "string" ? row.description : null,
      updated_at: row?.updated_at ?? null,
    };
  });

  return { ok: true, flags };
}

export async function updatePlatformFlag(
  key: string,
  enabled: boolean,
): Promise<UpdatePlatformFlagResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  if (!isPlatformFlagKey(key)) {
    return { ok: false, error: "invalid_payload" };
  }
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "invalid_payload" };
  }

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[superadmin/updatePlatformFlag] service role", e);
    return { ok: false, error: "server_error" };
  }

  const k: PlatformFlagKey = key;

  // Upsert so the row materializes on first toggle even when the
  // migration seed hasn't been applied on this environment.
  const { error } = await admin
    .from("platform_flags")
    .upsert(
      {
        key: k,
        enabled,
        updated_at: new Date().toISOString(),
        updated_by: caller.userId,
      } as never,
      { onConflict: "key" } as never,
    );

  if (error) {
    console.error("[superadmin/updatePlatformFlag] upsert", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, key: k, enabled };
}

// ─── service-category management ─────────────────────────────────────
//
// Public API: addCategory / updateCategory / deleteCategory. Deletes
// are SOFT — `deleted_at = now()` — so historical service rows that
// reference the slug still have a label to fall back on. Hard deletes
// are intentionally not exposed.

const CATEGORY_NAME_MAX_LEN = 80;

function normalizeCategoryName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return null;
  if (trimmed.length > CATEGORY_NAME_MAX_LEN) return null;
  return trimmed;
}

export async function loadAllCategories(): Promise<LoadAllCategoriesResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("service_categories")
    .select("slug, name_en, name_vi, sort_order, deleted_at")
    .order("sort_order", { ascending: true })
    .order("slug", { ascending: true });

  if (error) {
    console.error("[superadmin/loadAllCategories]", error);
    return { ok: false, error: "server_error" };
  }

  const rows: SuperAdminCategoryRow[] = (data ?? []).map((r) => {
    const row = r as unknown as {
      slug: string;
      name_en?: string | null;
      name_vi?: string | null;
      sort_order?: number | null;
      deleted_at?: string | null;
    };
    return {
      slug: String(row.slug ?? "").trim(),
      nameEn: String(row.name_en ?? row.slug ?? "").trim(),
      nameVi: String(row.name_vi ?? row.name_en ?? row.slug ?? "").trim(),
      sortOrder: Number.isFinite(Number(row.sort_order))
        ? Number(row.sort_order)
        : 0,
      deletedAt: row.deleted_at ?? null,
    };
  });

  return { ok: true, rows };
}

export async function addCategory(
  input: AddCategoryInput,
): Promise<CategoryMutationResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  if (!SUPERADMIN_CATEGORY_SLUG_RE.test(slug)) {
    return { ok: false, error: "invalid_slug" };
  }
  const nameEn = normalizeCategoryName(input.nameEn);
  const nameVi = normalizeCategoryName(input.nameVi);
  if (!nameEn || !nameVi) {
    return { ok: false, error: "invalid_name" };
  }
  const sortOrder =
    typeof input.sortOrder === "number" && Number.isFinite(input.sortOrder)
      ? Math.round(input.sortOrder)
      : 50;

  const admin = createServiceRoleClient();
  const { error } = await admin.from("service_categories").insert(
    {
      slug,
      name_en: nameEn,
      name_vi: nameVi,
      sort_order: sortOrder,
    } as never,
  );

  if (error) {
    // 23505 = unique_violation (slug already exists, including a
    // soft-deleted row). Surface a distinct code so the UI can offer
    // an "Undelete" path instead of forcing a different slug.
    const code = (error as { code?: string }).code;
    if (code === "23505") return { ok: false, error: "slug_already_exists" };
    console.error("[superadmin/addCategory]", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true };
}

export async function updateCategory(
  input: UpdateCategoryInput,
): Promise<CategoryMutationResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  if (!slug) return { ok: false, error: "invalid_slug" };

  const patch: Record<string, unknown> = {};
  if (input.nameEn !== undefined) {
    const normalized = normalizeCategoryName(input.nameEn);
    if (!normalized) return { ok: false, error: "invalid_name" };
    patch.name_en = normalized;
  }
  if (input.nameVi !== undefined) {
    const normalized = normalizeCategoryName(input.nameVi);
    if (!normalized) return { ok: false, error: "invalid_name" };
    patch.name_vi = normalized;
  }
  if (input.sortOrder !== undefined) {
    if (!Number.isFinite(input.sortOrder)) {
      return { ok: false, error: "invalid_sort_order" };
    }
    patch.sort_order = Math.round(input.sortOrder);
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "empty_update" };
  }

  const admin = createServiceRoleClient();
  const { error } = await admin
    .from("service_categories")
    .update(patch as never)
    .eq("slug", slug)
    .is("deleted_at" as never, null);

  if (error) {
    console.error("[superadmin/updateCategory]", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true };
}

export async function deleteCategory(
  slug: string,
): Promise<CategoryMutationResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  const trimmed = typeof slug === "string" ? slug.trim() : "";
  if (!trimmed) return { ok: false, error: "invalid_slug" };

  // Never hard-delete — history matters. The soft-delete here makes
  // the row disappear from `loadServiceCategories` (which filters on
  // `deleted_at IS NULL`) while preserving the row so historical
  // `services.category` values still resolve to a label if you join.
  const admin = createServiceRoleClient();
  const { error } = await admin
    .from("service_categories")
    .update({ deleted_at: new Date().toISOString() } as never)
    .eq("slug", trimmed)
    .is("deleted_at" as never, null);

  if (error) {
    console.error("[superadmin/deleteCategory]", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true };
}
