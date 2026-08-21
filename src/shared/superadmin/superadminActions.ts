"use server";

import { revalidatePath } from "next/cache";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type { SuperAdminRole } from "@/shared/lib/superadmin";
import { requireActiveSuperAdminSession } from "@/shared/auth/requireActiveSuperAdminSession";
import { writeAuditLog } from "@/shared/superadmin/audit";
import {
  graceDeadline,
  pauseTenant,
  resumeTenant,
  type TenantPauseReason,
} from "@/shared/subscriptions/tenantPause";
import {
  containsControlledRolloutFlagMutation,
  EDITABLE_RELEASE_FLAG_KEYS,
  RELEASE_FEATURE_KEYS,
  type ReleaseFeatureKey,
} from "@/shared/features/featureRegistry";
import { platformFeatureFlagKey } from "@/shared/features/platformFeatureFlags";
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
  type LoadAllUsersResult,
  type SuperAdminUserRow,
  type LoadDeletedRecordsResult,
  type LoadPlatformFlagsResult,
  type LoadSalonDetailResult,
  type PlatformFlag,
  type PlatformFlagKey,
  type RestorableTable,
  type RestoreSalonRecordResult,
  type SuperAdminCategoryRow,
  type SuperAdminFeatureFlags,
  type SuperAdminSalonDetail,
  type SuperAdminSalonRow,
  type TenantControlResult,
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
  role: SuperAdminRole;
};

async function requireSuperAdminCaller(): Promise<CallerContext | null> {
  const access = await requireActiveSuperAdminSession();
  if (!access.ok) return null;

  return {
    userId: access.user.id,
    email:
      typeof access.user.email === "string" ? access.user.email : null,
    role: access.role,
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
      "id, slug, name, phone, subscription_plan, subscription_status, plan_override, feature_flags, is_beta, admin_notes, created_at, voice_ai_enabled, archived_at, tenant_pause_reason, tenant_pause_note, payment_grace_ends_at" as never,
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
          voice_ai_enabled?: boolean | null;
          subscription_status?: string | null;
          archived_at?: string | null;
          tenant_pause_reason?: string | null;
          tenant_pause_note?: string | null;
          payment_grace_ends_at?: string | null;
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
      voice_ai_enabled: Boolean(row.voice_ai_enabled),
      subscription_status:
        typeof row.subscription_status === "string" ? row.subscription_status : null,
      archived_at: row.archived_at ?? null,
      tenant_pause_reason:
        row.tenant_pause_reason === "manual" || row.tenant_pause_reason === "non_payment"
          ? row.tenant_pause_reason
          : null,
      tenant_pause_note:
        typeof row.tenant_pause_note === "string" ? row.tenant_pause_note : null,
      payment_grace_ends_at: row.payment_grace_ends_at ?? null,
    };
  });

  return { ok: true, salons };
}

function startOfCurrentUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfLast7DaysUtc(): Date {
  const ms = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return new Date(ms);
}

/**
 * Load all Supabase auth users + their salon memberships for the
 * `/superadmin/users` page. Uses the admin API to list users (service
 * role only) then joins against `salon_members` + `salons` in one query.
 */
export async function loadAllUsers(): Promise<LoadAllUsersResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[superadmin/loadAllUsers] service role", e);
    return { ok: false, error: "server_error" };
  }

  // Fetch up to 1000 auth users (Supabase admin API limit per page).
  const { data: authData, error: authErr } =
    await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (authErr) {
    console.error("[superadmin/loadAllUsers] listUsers", authErr);
    return { ok: false, error: "server_error" };
  }

  // Fetch all salon memberships + salon names in one query.
  const { data: memberRows, error: memberErr } = (await admin
    .from("salon_members")
    .select("user_id, role, salon_id, salons!inner(id, name, slug)" as never)) as {
    data: Array<{
      user_id: string;
      role: string;
      salon_id: string;
      salons: { id: string; name: string | null; slug: string | null } | null;
    }> | null;
    error: unknown;
  };

  if (memberErr) {
    console.error("[superadmin/loadAllUsers] salon_members", memberErr);
    return { ok: false, error: "server_error" };
  }

  // Build user_id → memberships map.
  const membershipMap = new Map<string, SuperAdminUserRow["memberships"]>();
  for (const row of memberRows ?? []) {
    const salon = row.salons;
    if (!salon) continue;
    const list = membershipMap.get(row.user_id) ?? [];
    list.push({
      salonId: String(salon.id),
      salonName: String(salon.name ?? ""),
      salonSlug: String(salon.slug ?? ""),
      role: String(row.role ?? ""),
    });
    membershipMap.set(row.user_id, list);
  }

  const users: SuperAdminUserRow[] = (authData.users ?? []).map((u) => ({
    id: u.id,
    email: typeof u.email === "string" ? u.email : "(no email)",
    createdAt: u.created_at ?? null,
    lastSignInAt: u.last_sign_in_at ?? null,
    memberships: membershipMap.get(u.id) ?? [],
  }));

  // Sort: most recently active first.
  users.sort((a, b) => {
    const ta = a.lastSignInAt ?? a.createdAt ?? "";
    const tb = b.lastSignInAt ?? b.createdAt ?? "";
    return tb.localeCompare(ta);
  });

  return { ok: true, users };
}

/**
 * Single-salon detail view for `/superadmin/salons/[salonId]`.
 *
 * Returns the same row shape as `loadAllSalons` plus configuration
 * (timezone, currency, brand) and three aggregate counts: active
 * staff, active services, and last-7-day bookings. The aggregates
 * run in parallel after the base row resolves so the page renders
 * in roughly the time of the slowest query.
 */
export async function loadSalonDetail(
  salonId: string,
): Promise<LoadSalonDetailResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  const id = salonId.trim();
  if (!id) return { ok: false, error: "not_found" };

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[superadmin/loadSalonDetail] service role", e);
    return { ok: false, error: "server_error" };
  }

  const { data: row, error } = (await admin
    .from("salons")
    .select(
      "id, slug, name, phone, subscription_plan, subscription_status, plan_override, feature_flags, is_beta, admin_notes, created_at, timezone, currency_code, brand_color, theme_mode, voice_ai_enabled, archived_at, tenant_pause_reason, tenant_pause_note, payment_grace_ends_at" as never,
    )
    .eq("id", id)
    .maybeSingle()) as {
    data:
      | {
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
          timezone?: string | null;
          currency_code?: string | null;
          brand_color?: string | null;
          theme_mode?: string | null;
          voice_ai_enabled?: boolean | null;
          subscription_status?: string | null;
          archived_at?: string | null;
          tenant_pause_reason?: string | null;
          tenant_pause_note?: string | null;
          payment_grace_ends_at?: string | null;
        }
      | null;
    error: unknown;
  };

  if (error) {
    console.error("[superadmin/loadSalonDetail] query", error);
    return { ok: false, error: "server_error" };
  }
  if (!row?.id) {
    return { ok: false, error: "not_found" };
  }

  const monthStart = startOfCurrentUtcMonth();
  const last7Start = startOfLast7DaysUtc();

  const [staffRes, servicesRes, monthBookingsRes, last7BookingsRes, lastBookingRes] =
    await Promise.all([
      admin
        .from("staff")
        .select("id" as never, { count: "exact", head: true })
        .eq("salon_id", id)
        .is("deleted_at" as never, null),
      admin
        .from("services")
        .select("id" as never, { count: "exact", head: true })
        .eq("salon_id", id)
        .is("deleted_at" as never, null),
      admin
        .from("bookings")
        .select("id" as never, { count: "exact", head: true })
        .eq("salon_id", id)
        .gte("start_time_utc", monthStart.toISOString())
        .neq("status", "cancelled"),
      admin
        .from("bookings")
        .select("id" as never, { count: "exact", head: true })
        .eq("salon_id", id)
        .gte("start_time_utc", last7Start.toISOString())
        .neq("status", "cancelled"),
      admin
        .from("bookings")
        .select("created_at" as never)
        .eq("salon_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  if (staffRes.error) {
    console.error("[superadmin/loadSalonDetail] staff count", staffRes.error);
  }
  if (servicesRes.error) {
    console.error(
      "[superadmin/loadSalonDetail] services count",
      servicesRes.error,
    );
  }
  if (monthBookingsRes.error) {
    console.error(
      "[superadmin/loadSalonDetail] month bookings",
      monthBookingsRes.error,
    );
  }
  if (last7BookingsRes.error) {
    console.error(
      "[superadmin/loadSalonDetail] last7 bookings",
      last7BookingsRes.error,
    );
  }

  const lastBookingData = lastBookingRes.data as
    | { created_at?: string | null }
    | null;

  const themeRaw = typeof row.theme_mode === "string" ? row.theme_mode : null;
  const themeMode: "dark" | "light" | null =
    themeRaw === "dark" || themeRaw === "light" ? themeRaw : null;

  const detail: SuperAdminSalonDetail = {
    id: String(row.id),
    slug: String(row.slug ?? ""),
    name: String(row.name ?? "").trim(),
    phone: String(row.phone ?? "").trim(),
    subscription_plan:
      typeof row.subscription_plan === "string" ? row.subscription_plan : null,
    plan_override: normalizePlanOverride(row.plan_override),
    feature_flags: normalizeFeatureFlags(row.feature_flags),
    is_beta: Boolean(row.is_beta),
    admin_notes:
      typeof row.admin_notes === "string" && row.admin_notes.trim().length > 0
        ? row.admin_notes
        : null,
    created_at: row.created_at ?? null,
    bookings_this_month: Number(monthBookingsRes.count ?? 0),
    timezone:
      typeof row.timezone === "string" && row.timezone.trim().length > 0
        ? row.timezone.trim()
        : null,
    currency_code:
      typeof row.currency_code === "string" && row.currency_code.trim().length > 0
        ? row.currency_code.trim().toUpperCase()
        : null,
    brand_color:
      typeof row.brand_color === "string" && row.brand_color.trim().length > 0
        ? row.brand_color.trim()
        : null,
    theme_mode: themeMode,
    staff_count: Number(staffRes.count ?? 0),
    services_count: Number(servicesRes.count ?? 0),
    bookings_last_7d: Number(last7BookingsRes.count ?? 0),
    last_booking_created_at:
      typeof lastBookingData?.created_at === "string"
        ? lastBookingData.created_at
        : null,
    voice_ai_enabled: Boolean(row.voice_ai_enabled),
    subscription_status:
      typeof row.subscription_status === "string" ? row.subscription_status : null,
    archived_at: row.archived_at ?? null,
    tenant_pause_reason:
      row.tenant_pause_reason === "manual" || row.tenant_pause_reason === "non_payment"
        ? row.tenant_pause_reason
        : null,
    tenant_pause_note:
      typeof row.tenant_pause_note === "string" ? row.tenant_pause_note : null,
    payment_grace_ends_at: row.payment_grace_ends_at ?? null,
  };

  return { ok: true, salon: detail };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function loadTenantControlBefore(admin: ReturnType<typeof createServiceRoleClient>, salonId: string) {
  const { data, error } = await admin
    .from("salons")
    .select(
      "id, slug, archived_at, subscription_status, tenant_pause_reason, tenant_pause_note, payment_grace_ends_at, sms_outbound_enabled, email_outbound_enabled, reminders_enabled, voice_ai_enabled, voice_ai_upsell_enabled, winback_enabled, phone_otp_enabled, email_links_enabled" as never,
    )
    .eq("id", salonId)
    .maybeSingle();
  return { data: data as Record<string, unknown> | null, error };
}

export async function pauseSalonTenant(
  salonId: string,
  reason: TenantPauseReason,
  note: string,
): Promise<TenantControlResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };
  const id = salonId.trim();
  const cleanNote = note.trim();
  if (!UUID_RE.test(id) || !["manual", "non_payment"].includes(reason) || cleanNote.length < 3 || cleanNote.length > 500) {
    return { ok: false, error: "invalid_payload" };
  }

  const admin = createServiceRoleClient();
  const before = await loadTenantControlBefore(admin, id);
  if (before.error) return { ok: false, error: "server_error" };
  if (!before.data) return { ok: false, error: "not_found" };

  const audited = await writeAuditLog({
    actorUserId: caller.userId,
    actorRole: caller.role,
    action: reason === "non_payment" ? "tenant_pause_non_payment" : "tenant_pause_manual",
    targetKind: "salon",
    targetId: id,
    beforeJsonb: before.data,
    afterJsonb: { archived: true, reason, outbound: false, wixSquareChanged: false },
    reason: cleanNote,
  });
  if (!audited) return { ok: false, error: "server_error" };

  const paused = await pauseTenant(admin, {
    salonId: id,
    reason,
    note: cleanNote,
    actorUserId: caller.userId,
  });
  if (!paused.ok) {
    console.error("[superadmin/pauseSalonTenant] update", paused.error);
    return { ok: false, error: "server_error" };
  }
  revalidatePath(`/superadmin/salons/${id}`);
  revalidatePath("/superadmin/salons");
  return { ok: true };
}

export async function beginSalonPaymentGrace(
  salonId: string,
  days: number,
  note: string,
): Promise<TenantControlResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };
  const id = salonId.trim();
  const cleanNote = note.trim();
  if (!UUID_RE.test(id) || !Number.isFinite(days) || days < 1 || days > 30 || cleanNote.length < 3 || cleanNote.length > 500) {
    return { ok: false, error: "invalid_payload" };
  }

  const admin = createServiceRoleClient();
  const before = await loadTenantControlBefore(admin, id);
  if (before.error) return { ok: false, error: "server_error" };
  if (!before.data) return { ok: false, error: "not_found" };
  if (before.data.archived_at) return { ok: false, error: "invalid_payload" };
  const deadline = graceDeadline(days);

  const audited = await writeAuditLog({
    actorUserId: caller.userId,
    actorRole: caller.role,
    action: "tenant_payment_grace_start",
    targetKind: "salon",
    targetId: id,
    beforeJsonb: before.data,
    afterJsonb: { subscription_status: "past_due", payment_grace_ends_at: deadline },
    reason: cleanNote,
  });
  if (!audited) return { ok: false, error: "server_error" };

  const { error } = await admin
    .from("salons")
    .update({
      subscription_status: "past_due",
      payment_grace_ends_at: deadline,
      tenant_pause_note: cleanNote,
    } as never)
    .eq("id", id);
  if (error) {
    console.error("[superadmin/beginSalonPaymentGrace] update", error);
    return { ok: false, error: "server_error" };
  }
  revalidatePath(`/superadmin/salons/${id}`);
  revalidatePath("/superadmin/salons");
  return { ok: true };
}

export async function resumeSalonTenant(
  salonId: string,
  note: string,
): Promise<TenantControlResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };
  const id = salonId.trim();
  const cleanNote = note.trim();
  if (!UUID_RE.test(id) || cleanNote.length < 3 || cleanNote.length > 500) {
    return { ok: false, error: "invalid_payload" };
  }

  const admin = createServiceRoleClient();
  const before = await loadTenantControlBefore(admin, id);
  if (before.error) return { ok: false, error: "server_error" };
  if (!before.data) return { ok: false, error: "not_found" };

  const audited = await writeAuditLog({
    actorUserId: caller.userId,
    actorRole: caller.role,
    action: "tenant_resume",
    targetKind: "salon",
    targetId: id,
    beforeJsonb: before.data,
    afterJsonb: { archived: false, restoredFromSnapshot: true, wixSquareChanged: false },
    reason: cleanNote,
  });
  if (!audited) return { ok: false, error: "server_error" };

  const resumed = await resumeTenant(admin, id);
  if (!resumed.ok) {
    console.error("[superadmin/resumeSalonTenant] update", resumed.error);
    return { ok: false, error: "server_error" };
  }
  revalidatePath(`/superadmin/salons/${id}`);
  revalidatePath("/superadmin/salons");
  return { ok: true };
}

export async function updateSalonFlags(
  salonId: string,
  patch: UpdateSalonFlagsInput,
): Promise<UpdateSalonFlagsResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  const id = salonId.trim();
  if (!id) return { ok: false, error: "invalid_payload" };

  // QA-controlled rollouts must never be enabled, disabled, or reset through
  // either of the generic SuperAdmin flag editors. A dedicated setter will
  // need an exact disposable-tenant allowlist plus readiness/preflight proof;
  // until then this boundary is deliberately unavailable.
  if (
    containsControlledRolloutFlagMutation(
      patch.featureFlags,
      patch.featureFlagsUnset,
    )
  ) {
    return { ok: false, error: "invalid_payload" };
  }

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[superadmin/updateSalonFlags] service role", e);
    return { ok: false, error: "server_error" };
  }

  // Fetch current row so we can merge feature_flags (UI sends a partial
  // patch) AND capture a complete before-snapshot for the audit log.
  const { data: existing, error: fetchErr } = (await admin
    .from("salons")
    .select(
      "id, slug, plan_override, is_beta, admin_notes, feature_flags" as never,
    )
    .eq("id", id)
    .maybeSingle()) as {
    data: {
      id: string;
      slug?: string | null;
      plan_override?: string | null;
      is_beta?: boolean | null;
      admin_notes?: string | null;
      feature_flags?: unknown;
    } | null;
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

  // feature_flags changes come from two surfaces that share this action:
  //   - SalonOverrideCard: sends a `featureFlags` patch of raw boolean keys.
  //   - SalonReleaseFeaturesCard (PR4b): sends a `featureFlags` patch to set a
  //     mapped release key true/false, OR `featureFlagsUnset` to RESET a release
  //     key to its registry default by removing it entirely.
  // Both reduce to: merge the boolean patch over the existing flags, then strip
  // any whitelisted release keys requested for removal. Only editable release
  // jsonb keys may be removed — an unset of any other key is ignored, so reset
  // can never strip a billing flag or an unrelated SuperAdmin flag.
  const unsetKeys = Array.isArray(patch.featureFlagsUnset)
    ? patch.featureFlagsUnset.filter((k) => EDITABLE_RELEASE_FLAG_KEYS.has(k))
    : [];
  if (patch.featureFlags || unsetKeys.length > 0) {
    const merged: SuperAdminFeatureFlags = {
      ...normalizeFeatureFlags(existing.feature_flags),
      ...(patch.featureFlags ? normalizeFeatureFlags(patch.featureFlags) : {}),
    };
    for (const key of unsetKeys) {
      delete merged[key];
    }
    update.feature_flags = merged;
  }

  if ("voiceAiEnabled" in patch && typeof patch.voiceAiEnabled === "boolean") {
    update.voice_ai_enabled = patch.voiceAiEnabled;
  }

  if (Object.keys(update).length === 0) {
    return { ok: true };
  }

  // Audit BEFORE the mutation per §8.5 — failure here aborts cleanly.
  const audited = await writeAuditLog({
    actorUserId: caller.userId,
    actorRole: caller.role,
    action: "salon_flags_set",
    targetKind: "salon",
    targetId: id,
    beforeJsonb: {
      salon_slug: existing.slug ?? null,
      plan_override: normalizePlanOverride(existing.plan_override),
      is_beta: Boolean(existing.is_beta),
      admin_notes: existing.admin_notes ?? null,
      feature_flags: normalizeFeatureFlags(existing.feature_flags),
    },
    afterJsonb: { salon_slug: existing.slug ?? null, ...update },
  });
  if (!audited) {
    return { ok: false, error: "server_error" };
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

  // Snapshot the soft-deleted row first so the audit log captures
  // exactly which record was restored (and from when).
  const { data: prior, error: priorErr } = (await admin
    .from(t)
    .select("id, salon_id, deleted_at" as never)
    .eq("id", id)
    .not("deleted_at", "is", null)
    .maybeSingle()) as {
    data: { id?: string; salon_id?: string; deleted_at?: string | null } | null;
    error: unknown;
  };
  if (priorErr) {
    console.error("[superadmin/restoreSalonRecord] fetch", priorErr);
    return { ok: false, error: "server_error" };
  }
  if (!prior?.id) {
    return { ok: false, error: "not_found" };
  }

  const audited = await writeAuditLog({
    actorUserId: caller.userId,
    actorRole: caller.role,
    action: "record_restore",
    targetKind: t,
    targetId: id,
    beforeJsonb: {
      salon_id: prior.salon_id ?? null,
      deleted_at: prior.deleted_at ?? null,
    },
    afterJsonb: { salon_id: prior.salon_id ?? null, deleted_at: null },
  });
  if (!audited) {
    return { ok: false, error: "server_error" };
  }

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

  // Snapshot current enabled state (may not exist yet — first toggle).
  const { data: prior } = (await admin
    .from("platform_flags")
    .select("key, enabled" as never)
    .eq("key", k)
    .maybeSingle()) as {
    data: { key?: string; enabled?: boolean | null } | null;
    error: unknown;
  };

  // target_id is a uuid column; platform flag keys are text, so leave
  // target_id null and surface the key in the jsonb blobs.
  const audited = await writeAuditLog({
    actorUserId: caller.userId,
    actorRole: caller.role,
    action: "platform_flag_set",
    targetKind: "platform_flag",
    targetId: null,
    beforeJsonb: { key: k, enabled: prior?.enabled === true },
    afterJsonb: { key: k, enabled },
  });
  if (!audited) {
    return { ok: false, error: "server_error" };
  }

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

/**
 * Platform-wide feature kill-switch. Writes a `platform_flags` row keyed
 * `feature_<releaseKey>`; enabled=false hides the feature for EVERY salon
 * (overrides per-salon, per product decision). Mirrors `updatePlatformFlag`
 * (superadmin auth + audit-or-rollback + upsert).
 */
export async function updatePlatformFeatureFlag(
  key: string,
  enabled: boolean,
): Promise<
  { ok: true; key: string; enabled: boolean } | { ok: false; error: string }
> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  if (
    !RELEASE_FEATURE_KEYS.includes(key as ReleaseFeatureKey) ||
    typeof enabled !== "boolean"
  ) {
    return { ok: false, error: "invalid_payload" };
  }

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("[superadmin/updatePlatformFeatureFlag] service role", e);
    return { ok: false, error: "server_error" };
  }

  const rowKey = platformFeatureFlagKey(key as ReleaseFeatureKey);

  const { data: prior } = (await admin
    .from("platform_flags")
    .select("key, enabled" as never)
    .eq("key", rowKey)
    .maybeSingle()) as {
    data: { enabled?: boolean | null } | null;
    error: unknown;
  };

  const audited = await writeAuditLog({
    actorUserId: caller.userId,
    actorRole: caller.role,
    action: "platform_feature_flag_set",
    targetKind: "platform_flag",
    targetId: null,
    // Absent row counts as enabled (default ON).
    beforeJsonb: { key: rowKey, enabled: prior?.enabled !== false },
    afterJsonb: { key: rowKey, enabled },
  });
  if (!audited) {
    return { ok: false, error: "server_error" };
  }

  const { error } = await admin.from("platform_flags").upsert(
    {
      key: rowKey,
      enabled,
      updated_at: new Date().toISOString(),
      updated_by: caller.userId,
    } as never,
    { onConflict: "key" } as never,
  );

  if (error) {
    console.error("[superadmin/updatePlatformFeatureFlag] upsert", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, key: rowKey, enabled };
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

  const audited = await writeAuditLog({
    actorUserId: caller.userId,
    actorRole: caller.role,
    action: "category_add",
    targetKind: "service_category",
    targetId: null,
    beforeJsonb: null,
    afterJsonb: {
      slug,
      name_en: nameEn,
      name_vi: nameVi,
      sort_order: sortOrder,
    },
  });
  if (!audited) {
    return { ok: false, error: "server_error" };
  }

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

  // Snapshot the existing row so the audit log shows what changed.
  const { data: prior } = (await admin
    .from("service_categories")
    .select("slug, name_en, name_vi, sort_order" as never)
    .eq("slug", slug)
    .is("deleted_at" as never, null)
    .maybeSingle()) as {
    data: {
      slug?: string;
      name_en?: string | null;
      name_vi?: string | null;
      sort_order?: number | null;
    } | null;
    error: unknown;
  };
  if (!prior?.slug) {
    return { ok: false, error: "server_error" };
  }

  const audited = await writeAuditLog({
    actorUserId: caller.userId,
    actorRole: caller.role,
    action: "category_update",
    targetKind: "service_category",
    targetId: null,
    beforeJsonb: {
      slug,
      name_en: prior.name_en ?? null,
      name_vi: prior.name_vi ?? null,
      sort_order: prior.sort_order ?? null,
    },
    afterJsonb: { slug, ...patch },
  });
  if (!audited) {
    return { ok: false, error: "server_error" };
  }

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

  // Snapshot pre-delete state for the audit trail.
  const { data: prior } = (await admin
    .from("service_categories")
    .select("slug, name_en, name_vi, sort_order" as never)
    .eq("slug", trimmed)
    .is("deleted_at" as never, null)
    .maybeSingle()) as {
    data: {
      slug?: string;
      name_en?: string | null;
      name_vi?: string | null;
      sort_order?: number | null;
    } | null;
    error: unknown;
  };
  if (!prior?.slug) {
    return { ok: false, error: "server_error" };
  }

  const deletedAt = new Date().toISOString();
  const audited = await writeAuditLog({
    actorUserId: caller.userId,
    actorRole: caller.role,
    action: "category_delete",
    targetKind: "service_category",
    targetId: null,
    beforeJsonb: {
      slug: trimmed,
      name_en: prior.name_en ?? null,
      name_vi: prior.name_vi ?? null,
      sort_order: prior.sort_order ?? null,
      deleted_at: null,
    },
    afterJsonb: { slug: trimmed, deleted_at: deletedAt },
  });
  if (!audited) {
    return { ok: false, error: "server_error" };
  }

  const { error } = await admin
    .from("service_categories")
    .update({ deleted_at: deletedAt } as never)
    .eq("slug", trimmed)
    .is("deleted_at" as never, null);

  if (error) {
    console.error("[superadmin/deleteCategory]", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true };
}

// ─── Platform Settings ─────────────────────────────────────────────────────

const MASK = "••••••••";

export type PlatformSettingsRow = {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioVerifyServiceSid: string;
  twilioPhoneNumber: string;
  resendApiKey: string;
  resendFrom: string;
  updatedAt: string | null;
};

type LoadPlatformSettingsResult =
  | { ok: true; settings: PlatformSettingsRow }
  | { ok: false; error: string };

function maskSecret(v: string | null | undefined): string {
  if (!v || v.trim().length === 0) return "";
  return MASK + v.trim().slice(-4);
}

export async function loadPlatformSettings(): Promise<LoadPlatformSettingsResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("platform_settings")
    .select(
      "twilio_account_sid, twilio_auth_token, twilio_verify_service_sid, twilio_phone_number, resend_api_key, resend_from, updated_at",
    )
    .eq("id", "platform")
    .maybeSingle();

  if (error) {
    console.error("[superadmin/loadPlatformSettings]", error);
    return { ok: false, error: "server_error" };
  }

  const row = (data ?? {}) as {
    twilio_account_sid?: string | null;
    twilio_auth_token?: string | null;
    twilio_verify_service_sid?: string | null;
    twilio_phone_number?: string | null;
    resend_api_key?: string | null;
    resend_from?: string | null;
    updated_at?: string | null;
  };

  return {
    ok: true,
    settings: {
      twilioAccountSid: maskSecret(row.twilio_account_sid),
      twilioAuthToken: maskSecret(row.twilio_auth_token),
      twilioVerifyServiceSid: maskSecret(row.twilio_verify_service_sid),
      twilioPhoneNumber: row.twilio_phone_number?.trim() ?? "",
      resendApiKey: maskSecret(row.resend_api_key),
      resendFrom: row.resend_from?.trim() ?? "",
      updatedAt: row.updated_at ?? null,
    },
  };
}

export type UpdatePlatformSettingsInput = {
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioVerifyServiceSid?: string;
  twilioPhoneNumber?: string;
  resendApiKey?: string;
  resendFrom?: string;
};

type UpdatePlatformSettingsResult =
  | { ok: true }
  | { ok: false; error: string };

export async function updatePlatformSettings(
  input: UpdatePlatformSettingsInput,
): Promise<UpdatePlatformSettingsResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  const admin = createServiceRoleClient();

  // Fetch current to avoid overwriting unchanged masked values.
  const { data: current } = await admin
    .from("platform_settings")
    .select(
      "twilio_account_sid, twilio_auth_token, twilio_verify_service_sid, twilio_phone_number, resend_api_key, resend_from",
    )
    .eq("id", "platform")
    .maybeSingle();

  const cur = (current ?? {}) as Record<string, string | null>;

  function resolveField(
    newVal: string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for future masking logic that may need to compare against current value
    _currentVal: string | null | undefined,
  ): string | null | undefined {
    if (newVal === undefined) return undefined; // not submitted
    const trimmed = newVal.trim();
    if (trimmed.startsWith(MASK)) return undefined; // still masked → keep current
    if (trimmed.length === 0) return null; // explicit clear
    return trimmed;
  }

  const patch: Record<string, string | null> = {};
  const taSid = resolveField(input.twilioAccountSid, cur.twilio_account_sid);
  if (taSid !== undefined) patch.twilio_account_sid = taSid;
  const taTok = resolveField(input.twilioAuthToken, cur.twilio_auth_token);
  if (taTok !== undefined) patch.twilio_auth_token = taTok;
  const tvSid = resolveField(input.twilioVerifyServiceSid, cur.twilio_verify_service_sid);
  if (tvSid !== undefined) patch.twilio_verify_service_sid = tvSid;
  if (input.twilioPhoneNumber !== undefined) {
    patch.twilio_phone_number = input.twilioPhoneNumber.trim() || null;
  }
  const rKey = resolveField(input.resendApiKey, cur.resend_api_key);
  if (rKey !== undefined) patch.resend_api_key = rKey;
  if (input.resendFrom !== undefined) {
    patch.resend_from = input.resendFrom.trim() || null;
  }
  patch.updated_at = new Date().toISOString();

  const { error } = await admin
    .from("platform_settings")
    .update(patch as never)
    .eq("id", "platform");

  if (error) {
    console.error("[superadmin/updatePlatformSettings]", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true };
}

type TestResult = { ok: true; message: string } | { ok: false; error: string };

export async function testTwilioConnection(): Promise<TestResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  const { sendVerification } = await import("@/shared/lib/twilioVerify");
  // Twilio Verify will reject a non-real number but the HTTP call itself
  // succeeds when credentials are valid — we look for a specific error code.
  const result = await sendVerification("+10000000000");
  if (result.ok) {
    return { ok: true, message: "Twilio connected ✓" };
  }
  // 21211 = invalid To number → credentials ARE valid, number just fake.
  if ((result.error ?? "").includes("21211") || (result.error ?? "").toLowerCase().includes("invalid")) {
    return { ok: true, message: "Twilio connected ✓ (credentials valid)" };
  }
  if ((result.error ?? "").includes("misconfigured") || (result.error ?? "").includes("missing")) {
    return { ok: false, error: "Credentials not set or incomplete." };
  }
  return { ok: false, error: result.error ?? "Connection failed." };
}

export async function testResendConnection(
  toEmail: string,
): Promise<TestResult> {
  const caller = await requireSuperAdminCaller();
  if (!caller) return { ok: false, error: "unauthorized" };

  if (!toEmail || !toEmail.includes("@")) {
    return { ok: false, error: "invalid_email" };
  }

  // Read resend key from platform_settings, fallback to env.
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("platform_settings")
    .select("resend_api_key, resend_from")
    .eq("id", "platform")
    .maybeSingle();

  const row = (data ?? {}) as {
    resend_api_key?: string | null;
    resend_from?: string | null;
  };

  const apiKey =
    row.resend_api_key?.trim() || process.env.RESEND_API_KEY?.trim() || "";
  const fromAddr =
    row.resend_from?.trim() || process.env.RESEND_FROM?.trim() || "";

  if (!apiKey) return { ok: false, error: "Resend API key not configured." };

  try {
    const { Resend } = await import("resend");
    const resend = new Resend(apiKey);
    const res = await resend.emails.send({
      from: fromAddr || "NailIQ <noreply@nailiq.ca>",
      to: toEmail.trim(),
      subject: "NailIQ — Resend connection test",
      html: "<p>Resend is connected to NailIQ. This is a test email from SuperAdmin.</p>",
    });
    if (res.error) {
      return { ok: false, error: String(res.error.message ?? res.error) };
    }
    return { ok: true, message: `Test email sent to ${toEmail} ✓` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
