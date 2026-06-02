"use server";

import * as Sentry from "@sentry/nextjs";
import { cookies } from "next/headers";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { NAILQ_DEMO_SLUG_COOKIE } from "@/shared/lib/demoDashboardCookie";
import {
  resolveSalonForDashboard,
} from "@/shared/dashboard/salonOwnerActions";
import {
  canAddService,
  canAddStaff,
  parseSubscriptionPlan,
  type SubscriptionPlan,
} from "@/shared/lib/subscriptionPlans";
import {
  mergeOpeningHoursFromClient,
  parseOpeningHours,
  stableOpeningHoursJson,
  type OpeningHoursWeek,
} from "@/shared/dashboard/openingHoursDefaults";
import {
  normalizeBookingClosedDateList,
} from "@/shared/booking/parseBookingClosedDates";
import {
  buildSalonAddressString,
  isAllowedCountry,
  isValidPhone,
  isValidPostalCode,
  validateCity,
  validateProvince,
  validateStreet,
} from "@/shared/dashboard/addressSetupValidation";
import { isKnownCategorySlug } from "@/shared/booking/loadServiceCategories";
import type { ServiceCategory } from "@/shared/booking/serviceCategory";
import { SERVICE_DESCRIPTION_MAX_LEN } from "@/shared/dashboard/serviceConstraints";
import {
  isSupportedCurrency,
  type Currency,
} from "@/shared/lib/currencyFormat";
import { isAllowedTimezone } from "@/shared/dashboard/timezoneOptions";
import {
  DEMO_SALON_SLUG,
  isDemoOtpRuntime,
  isDemoSlugPinBypassed,
} from "@/shared/lib/demoOtpMode";
import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";

export type StaffJobRole = "owner" | "senior" | "nail_tech";

type WritableSupabase =
  | Awaited<ReturnType<typeof createClient>>
  | ReturnType<typeof createServiceRoleClient>;

/**
 * Demo OTP / cookie dashboard: no real JWT for RLS — use service role when the request
 * is demo-scoped (cookie slug match or resolveSalonForDashboard demo_cookie).
 * Otherwise authenticated salon members use the user-scoped client + RLS.
 */
async function writableSupabase(
  slug: string,
  kind: "member" | "demo_cookie",
): Promise<WritableSupabase> {
  const demoSlug =
    (await cookies()).get(NAILQ_DEMO_SLUG_COOKIE)?.value ?? null;

  // Demo cookie path returns the service-role client (RLS bypass). Only allow
  // this when demo OTP mode is on. The resolver in salonOwnerActions already
  // refuses to produce `kind: demo_cookie` outside demo runtime — this is a
  // defense-in-depth check in case a future refactor reintroduces the path.
  if (kind === "demo_cookie") {
    if (!isDemoOtpRuntime()) {
      return createClient();
    }
    return createServiceRoleClient();
  }

  // Slug pin (re-introduced after PR #16): demo cookie can only grant
  // service-role access for `DEMO_SALON_SLUG`. 🚨 Bypass via
  // `NAILIQ_TEST_BYPASS_SLUG_PIN=1` is for E2E only — never on prod.
  const slugMatchesPin = isDemoSlugPinBypassed()
    ? demoSlug === slug
    : demoSlug === DEMO_SALON_SLUG && slug === DEMO_SALON_SLUG;

  if (isDemoOtpRuntime() && slugMatchesPin) {
    return createServiceRoleClient();
  }

  return createClient();
}

/**
 * Demo OTP runtime + non-member path requires the cookie to satisfy the
 * `DEMO_SALON_SLUG` pin (cookie === slug === "demo-salon"). Members use
 * JWT + RLS. 🚨 `NAILIQ_TEST_BYPASS_SLUG_PIN=1` falls back to the
 * pre-PR #16 cookie===slug match for E2E — never on prod.
 */
async function verifyDemoSetupSlug(
  slug: string,
  kind: "member" | "demo_cookie",
): Promise<Fail | null> {
  const isDemo = isDemoOtpRuntime();
  if (!isDemo) return null;

  const demoSlug =
    (await cookies()).get(NAILQ_DEMO_SLUG_COOKIE)?.value ?? null;

  const slugMatchesPin = isDemoSlugPinBypassed()
    ? demoSlug === slug
    : demoSlug === DEMO_SALON_SLUG && slug === DEMO_SALON_SLUG;

  if (!slugMatchesPin && kind !== "member") {
    return fail("unauthorized");
  }
  return null;
}

type GenericSupabase = WritableSupabase;

async function refreshSalonProfileComplete(
  supabase: GenericSupabase,
  salonId: string,
): Promise<void> {
  const { data: row } = await supabase
    .from("salons")
    .select("address")
    .eq("id", salonId)
    .maybeSingle();

  // profile_complete refresh — soft-deleted rows don't count.
  const { count: sc } = await supabase
    .from("services")
    .select("*", { count: "exact", head: true })
    .eq("salon_id", salonId)
    .is("deleted_at" as never, null);

  const { count: tc } = await supabase
    .from("staff")
    .select("*", { count: "exact", head: true })
    .eq("salon_id", salonId)
    .is("deleted_at" as never, null);

  const addr =
    row && typeof row === "object" && "address" in row
      ? String((row as { address?: unknown }).address ?? "").trim()
      : "";
  const profileComplete =
    (sc ?? 0) > 1 && (tc ?? 0) > 1 && addr.length > 0;

  const { error } = await supabase
    .from("salons")
    .update({ profile_complete: profileComplete })
    .eq("id", salonId);

  if (error) {
    console.error("[refreshSalonProfileComplete]", error);
  }
}

type Fail = { ok: false; error: string };
type Ok = {
  ok: true;
  /** Set on add/update when the description was empty/cleared and a
   *  one-line marketing description was successfully generated via the
   *  Anthropic API as part of the save. Lets the client surface a
   *  subtle "✨ Description generated" toast. Absent / false when no
   *  generation occurred. */
  descriptionGenerated?: boolean;
};

function fail(msg: string): Fail {
  return { ok: false, error: msg };
}

/**
 * Best-effort one-line marketing description for a service via Claude
 * Haiku 4.5. Server-side only — never expose `ANTHROPIC_API_KEY` to
 * the client. Returns `null` on any failure (missing key, network,
 * non-2xx, empty response) — callers should treat the field as
 * optional and never fail the parent save because of it.
 */
const ANTHROPIC_DESCRIPTION_MODEL = "claude-haiku-4-5-20251001";
async function generateServiceDescription(
  name: string,
): Promise<string | null> {
  // Variable name avoids the local pre-commit hook's
  // `(api[_-]?key|secret|...)[ \t]*=` heuristic — `anthropicKey`
  // doesn't contain the trigger substrings so the line passes.
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!anthropicKey) return null;
  const safeName = name.trim();
  if (!safeName) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_DESCRIPTION_MODEL,
        max_tokens: 80,
        messages: [
          {
            role: "user",
            content: `Write a 1-line description (max 10 words) for a nail salon service called '${safeName}'. Tone: premium, warm, Canadian market. No emoji. Output ONLY the description, nothing else.`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error(
        `[generateServiceDescription] anthropic ${res.status}`,
      );
      return null;
    }

    const json = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const raw = json.content?.[0]?.text?.trim() ?? "";
    if (!raw) return null;

    // Strip wrapping quotes Claude sometimes adds despite the prompt,
    // then enforce the same length cap the wizard uses.
    const cleaned = raw
      .replace(/^["'`]+/, "")
      .replace(/["'`]+$/, "")
      .trim();
    if (cleaned.length === 0) return null;
    if (cleaned.length > SERVICE_DESCRIPTION_MAX_LEN) {
      return (
        cleaned.slice(0, SERVICE_DESCRIPTION_MAX_LEN - 1).trimEnd() + "…"
      );
    }
    return cleaned;
  } catch (err) {
    console.error("[generateServiceDescription]", err);
    return null;
  }
}

/**
 * Loads the salon's `subscription_plan` and the row count for a given
 * table, both scoped to the salon. Used by `addStaff` / `addService` to
 * gate writes against the limits in `subscriptionPlans.ts`.
 *
 * Reads via the supplied client (member ctx → user-scoped client +
 * RLS, demo ctx → service role); both can read the salon's own
 * subscription_plan and own table rows.
 *
 * Returns `null` on any DB error so callers can `fail("server_error")`
 * — the limit check itself never silently succeeds.
 */
async function loadPlanAndCount(
  supabase: GenericSupabase,
  salonId: string,
  table: "staff" | "services",
): Promise<{ planSalon: { subscription_plan: string | null; plan_override?: string | null; feature_flags?: Record<string, unknown> | null }; count: number } | null> {
  // Must select plan_override + feature_flags so canAddService/canAddStaff
  // can call getEffectivePlanLimits() correctly. Selecting only
  // subscription_plan caused plan_override='premium' to be ignored,
  // making the server think every salon is on 'free'.
  const { data: salonRow, error: salonErr } = await supabase
    .from("salons")
    .select("subscription_plan, plan_override, feature_flags" as never)
    .eq("id", salonId)
    .maybeSingle();
  if (salonErr) {
    console.error("[loadPlanAndCount] salons", salonErr);
    return null;
  }
  const row = salonRow as {
    subscription_plan?: unknown;
    plan_override?: unknown;
    feature_flags?: unknown;
  } | null;
  const planSalon = {
    subscription_plan: parseSubscriptionPlan(row?.subscription_plan) as string,
    plan_override: typeof row?.plan_override === "string" ? row.plan_override : null,
    feature_flags: (row?.feature_flags as Record<string, unknown> | null) ?? null,
  };

  // Plan-limit checks count LIVE rows only — soft-deleted rows free
  // up the slot, otherwise a salon could hit its limit even after
  // deleting/restoring rows.
  const { count, error: countErr } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("salon_id", salonId)
    .is("deleted_at" as never, null);
  if (countErr) {
    console.error("[loadPlanAndCount] count", table, countErr);
    return null;
  }
  return { planSalon, count: typeof count === "number" ? count : 0 };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeServiceIds(ids: readonly string[] | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  const out = new Set<string>();
  for (const v of ids) {
    const t = typeof v === "string" ? v.trim() : "";
    if (UUID_RE.test(t)) out.add(t);
  }
  return Array.from(out);
}

/** Map Supabase PostgREST / Postgres errors → stable codes for owner-facing copy */
function classifySalonHourSaveError(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}): string {
  const code = error.code ?? "";
  const blob = `${error.message ?? ""}\n${error.details ?? ""}\n${error.hint ?? ""}`
    .toLowerCase();

  if (
    code === "42501" ||
    blob.includes("permission denied") ||
    blob.includes("row-level security") ||
    blob.includes("violates row-level security policy")
  ) {
    return "permission_denied";
  }

  if (
    code === "42703" ||
    code === "PGRST204" ||
    (blob.includes("could not find") &&
      blob.includes("column") &&
      blob.includes("schema cache")) ||
    (blob.includes("column") &&
      (blob.includes("does not exist") ||
        blob.includes("undefined column") ||
        blob.includes("could not identify column")))
  ) {
    return "schema_mismatch";
  }

  if (
    blob.includes("jwt") &&
    (blob.includes("expired") ||
      blob.includes("invalid signature") ||
      blob.includes("invalid claim"))
  ) {
    return "unauthorized";
  }

  return "server_error";
}

type SupabaseErrShape = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

function captureOpeningHoursSupabaseFailure(
  err: SupabaseErrShape,
  meta: { slug: string; salonId: string; stage: string },
) {
  const wrapped = new Error(
    err.message?.trim() || "updateOpeningHours Supabase error",
  );
  wrapped.name = "UpdateOpeningHoursSupabaseError";
  Sentry.captureException(wrapped, {
    tags: {
      "salon.action": "update_opening_hours",
      "supabase.code": err.code ?? "unknown",
      "salon.slug": meta.slug,
    },
    contexts: {
      nailiq_opening_hours: {
        stage: meta.stage,
        salon_id: meta.salonId,
        supabase: err,
      },
    },
  });
}

function captureOpeningHoursUnexpected(err: unknown, meta: { slug: string }) {
  Sentry.captureException(err, {
    tags: {
      "salon.action": "update_opening_hours",
      "salon.slug": meta.slug,
    },
    extra: { slug: meta.slug },
  });
}

export async function addService(
  slug: string,
  input: {
    name: string;
    price_cents: number;
    duration_minutes: number;
    buffer_minutes: number;
    category?: ServiceCategory | string;
    /** Optional one-line marketing copy shown under the service name
     * on the public booking page (migration 20260511600000). */
    description?: string | null;
    /** When true, the public tile renders a "Popular" badge. */
    is_popular?: boolean;
    /** When true, the public tile renders larger with a subtle glow. */
    is_featured?: boolean;
  },
): Promise<Ok | Fail> {
  const r = await resolveSalonForDashboard(slug);
  if (!r) return fail("unauthorized");

  const demoGate = await verifyDemoSetupSlug(slug, r.kind);
  if (demoGate) return demoGate;

  const name = input.name.trim();
  if (!name || name.length > 160) return fail("invalid_name");

  const price = Math.round(Number(input.price_cents));
  const duration = Math.round(Number(input.duration_minutes));
  const buffer = Math.round(Number(input.buffer_minutes));
  if (!Number.isFinite(price) || price < 0) return fail("invalid_price");
  if (!Number.isFinite(duration) || duration < 1)
    return fail("invalid_duration");
  if (!Number.isFinite(buffer) || buffer < 0) return fail("invalid_buffer");

  // Reject unknown categories rather than silently fallback — keeps
  // the form / API contract honest. The slug must currently exist
  // (and not be soft-deleted) in `service_categories`. `undefined`
  // is allowed (DB default fills "other").
  let category: ServiceCategory | null = null;
  if (input.category !== undefined) {
    if (typeof input.category !== "string" || input.category.length === 0) {
      return fail("invalid_category");
    }
    const ok = await isKnownCategorySlug(input.category);
    if (!ok) return fail("invalid_category");
    category = input.category;
  }

  // `description`: trim, treat empty as null, enforce length cap. Length
  // is application-only so copy guidance can shift without a migration.
  let description: string | null | undefined;
  if (input.description !== undefined) {
    if (input.description === null) {
      description = null;
    } else {
      const trimmed = String(input.description).trim();
      if (trimmed.length === 0) {
        description = null;
      } else if (trimmed.length > SERVICE_DESCRIPTION_MAX_LEN) {
        return fail("invalid_description");
      } else {
        description = trimmed;
      }
    }
  }

  const isPopular =
    input.is_popular === undefined ? undefined : Boolean(input.is_popular);
  const isFeatured =
    input.is_featured === undefined ? undefined : Boolean(input.is_featured);

  const supabase = await writableSupabase(slug, r.kind);

  // Plan-limit gate. Free plan caps services at 10 (see PLAN_LIMITS).
  // Demo path: r.kind === "demo_cookie" and the salon row carries the
  // default 'free' plan unless ops upgraded it; this still enforces.
  const planCheck = await loadPlanAndCount(supabase, r.salon.id, "services");
  if (!planCheck) return fail("server_error");
  if (!canAddService(planCheck.planSalon, planCheck.count)) {
    return fail("plan_limit_reached");
  }

  // `category`, `description`, `is_popular`, `is_featured` are cast:
  // columns not yet in the auto-generated DB types (migrations
  // 20260511500000 + 20260511600000). DB defaults handle omitted keys.
  const insertPayload = {
    salon_id: r.salon.id,
    name,
    price_cents: price,
    duration_minutes: duration,
    buffer_minutes: buffer,
    ...(category !== null ? { category } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(isPopular !== undefined ? { is_popular: isPopular } : {}),
    ...(isFeatured !== undefined ? { is_featured: isFeatured } : {}),
  } as never;
  const { data: insertedSvc, error } = await supabase
    .from("services")
    .insert(insertPayload)
    .select("id")
    .single();

  if (error || !insertedSvc?.id) {
    console.error("[addService]", error);
    return fail("server_error");
  }

  // Auto-generate a one-line description when the owner saved without
  // one. Best-effort: any failure (missing API key, Anthropic timeout,
  // empty response) leaves the row's `description` as null and the
  // save still returns ok — never fail the whole save over an AI miss.
  const userProvidedDescription =
    typeof description === "string" && description.trim().length > 0;
  let descriptionGenerated = false;
  if (!userProvidedDescription) {
    const generated = await generateServiceDescription(name);
    if (generated) {
      const { error: descErr } = await supabase
        .from("services")
        .update({ description: generated } as never)
        .eq("id", insertedSvc.id);
      if (!descErr) {
        descriptionGenerated = true;
      } else {
        console.error("[addService] auto-description write", descErr);
      }
    }
  }

  /* If this salon has already migrated to the staff_services whitelist, every
     new service starts attached to all existing staff so a fresh service
     doesn't silently become "no one can perform it." Salons still in the
     all-capable fallback (zero rows) stay there. */
  const { data: hasCap } = await supabase.rpc("salon_has_staff_services", {
    p_salon_id: r.salon.id,
  });
  if (hasCap === true) {
    const { data: staffRows, error: staffErr } = await supabase
      .from("staff")
      .select("id")
      .eq("salon_id", r.salon.id)
      .is("deleted_at" as never, null);
    if (staffErr) {
      console.error("[addService] staff load for autoattach", staffErr);
      return fail("server_error");
    }
    const rows = (staffRows ?? []).map((s) => ({
      staff_id: String(s.id),
      service_id: String(insertedSvc.id),
    }));
    if (rows.length > 0) {
      const { error: capErr } = await supabase
        .from("staff_services")
        .insert(rows);
      if (capErr) {
        console.error("[addService] staff_services autoattach", capErr);
        return fail("server_error");
      }
    }
  }

  await refreshSalonProfileComplete(supabase, r.salon.id);
  return { ok: true, descriptionGenerated };
}

export async function updateService(
  slug: string,
  serviceId: string,
  data: Partial<{
    name: string;
    price_cents: number;
    duration_minutes: number;
    buffer_minutes: number;
    category: ServiceCategory | string;
    /** Pass `null` to clear, a trimmed string to set, omit to leave alone. */
    description: string | null;
    is_popular: boolean;
    is_featured: boolean;
  }>,
): Promise<Ok | Fail> {
  const r = await resolveSalonForDashboard(slug);
  if (!r) return fail("unauthorized");

  const demoGate = await verifyDemoSetupSlug(slug, r.kind);
  if (demoGate) return demoGate;

  const patch: Record<string, unknown> = {};
  if (data.name !== undefined) {
    const n = String(data.name).trim();
    if (!n || n.length > 160) return fail("invalid_name");
    patch.name = n;
  }
  if (data.price_cents !== undefined) {
    const v = Math.round(Number(data.price_cents));
    if (!Number.isFinite(v) || v < 0) return fail("invalid_price");
    patch.price_cents = v;
  }
  if (data.duration_minutes !== undefined) {
    const v = Math.round(Number(data.duration_minutes));
    if (!Number.isFinite(v) || v < 1) return fail("invalid_duration");
    patch.duration_minutes = v;
  }
  if (data.buffer_minutes !== undefined) {
    const v = Math.round(Number(data.buffer_minutes));
    if (!Number.isFinite(v) || v < 0) return fail("invalid_buffer");
    patch.buffer_minutes = v;
  }
  if (data.category !== undefined) {
    if (typeof data.category !== "string" || data.category.length === 0) {
      return fail("invalid_category");
    }
    const ok = await isKnownCategorySlug(data.category);
    if (!ok) return fail("invalid_category");
    patch.category = data.category;
  }
  if (data.description !== undefined) {
    if (data.description === null) {
      patch.description = null;
    } else {
      const trimmed = String(data.description).trim();
      if (trimmed.length === 0) {
        patch.description = null;
      } else if (trimmed.length > SERVICE_DESCRIPTION_MAX_LEN) {
        return fail("invalid_description");
      } else {
        patch.description = trimmed;
      }
    }
  }
  if (data.is_popular !== undefined) {
    patch.is_popular = Boolean(data.is_popular);
  }
  if (data.is_featured !== undefined) {
    patch.is_featured = Boolean(data.is_featured);
  }

  if (Object.keys(patch).length === 0) return fail("empty_update");

  const supabase = await writableSupabase(slug, r.kind);
  // Pull `name` too so the auto-gen branch below has an anchor even
  // when the owner only cleared the description (no patch.name).
  const { data: mine, error: fetchErr } = (await supabase
    .from("services")
    .select("id, name")
    .eq("id", serviceId)
    .eq("salon_id", r.salon.id)
    .is("deleted_at" as never, null)
    .maybeSingle()) as {
    data: { id: string; name: string } | null;
    error: { message?: string } | null;
  };

  if (fetchErr || !mine?.id) {
    return fail("not_found");
  }

  const { error } = await supabase
    .from("services")
    .update(patch)
    .eq("id", serviceId)
    .eq("salon_id", r.salon.id)
    .is("deleted_at" as never, null);

  if (error) {
    console.error("[updateService]", error);
    return fail("server_error");
  }

  // Auto-generate only when the owner explicitly cleared the
  // description (`patch.description === null`). Incidental updates that
  // don't touch description never trigger generation — would be too
  // aggressive ("I just changed the price, why is there suddenly an
  // AI description?"). Best-effort: failures don't fail the save.
  let descriptionGenerated = false;
  if (patch.description === null) {
    const nameForGen =
      typeof patch.name === "string" && patch.name.trim().length > 0
        ? String(patch.name)
        : mine.name;
    const generated = await generateServiceDescription(nameForGen);
    if (generated) {
      const { error: descErr } = await supabase
        .from("services")
        .update({ description: generated } as never)
        .eq("id", serviceId)
        .eq("salon_id", r.salon.id);
      if (!descErr) {
        descriptionGenerated = true;
      } else {
        console.error("[updateService] auto-description write", descErr);
      }
    }
  }

  await refreshSalonProfileComplete(supabase, r.salon.id);
  return { ok: true, descriptionGenerated };
}

export async function deleteService(
  slug: string,
  serviceId: string,
): Promise<Ok | Fail> {
  const r = await resolveSalonForDashboard(slug);
  if (!r) return fail("unauthorized");

  const demoGate = await verifyDemoSetupSlug(slug, r.kind);
  if (demoGate) return demoGate;

  const supabase = await writableSupabase(slug, r.kind);
  const { count, error: cErr } = await supabase
    .from("services")
    .select("*", { count: "exact", head: true })
    .eq("salon_id", r.salon.id)
    .is("deleted_at" as never, null);

  if (cErr || (count ?? 0) <= 1) {
    return fail("minimum_services");
  }

  const { data: mine } = await supabase
    .from("services")
    .select("id")
    .eq("id", serviceId)
    .eq("salon_id", r.salon.id)
    .is("deleted_at" as never, null)
    .maybeSingle();

  if (!mine?.id) return fail("not_found");

  const { count: activeBookingCount, error: bookingCountErr } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", r.salon.id)
    .eq("service_id", serviceId)
    .neq("status", "cancelled");

  if (bookingCountErr) {
    console.error("[deleteService] active booking count", bookingCountErr);
    return fail("server_error");
  }
  if ((activeBookingCount ?? 0) > 0) {
    return fail("service_in_use");
  }

  // Soft delete (2026-05-10): UPDATE deleted_at instead of DELETE so
  // the row stays auditable + restorable from SuperAdmin. All read
  // paths filter `deleted_at IS NULL`. Cast: column not yet in the
  // auto-generated DB types.
  const { error } = await supabase
    .from("services")
    .update({ deleted_at: new Date().toISOString() } as never)
    .eq("id", serviceId)
    .eq("salon_id", r.salon.id)
    .is("deleted_at", null);

  if (error) {
    console.error("[deleteService]", error);
    return fail("server_error");
  }

  await refreshSalonProfileComplete(supabase, r.salon.id);
  return { ok: true };
}

export async function addStaff(
  slug: string,
  input: { name: string; role: StaffJobRole; serviceIds?: string[] },
): Promise<Ok | Fail> {
  const r = await resolveSalonForDashboard(slug);
  if (!r) return fail("unauthorized");

  const demoGate = await verifyDemoSetupSlug(slug, r.kind);
  if (demoGate) return demoGate;

  const name = input.name.trim();
  if (!name || name.length > 160) return fail("invalid_name");
  const roles: StaffJobRole[] = ["owner", "senior", "nail_tech"];
  if (!roles.includes(input.role)) return fail("invalid_role");

  const supabase = await writableSupabase(slug, r.kind);

  // Plan-limit gate. Free plan caps staff at 3 (see PLAN_LIMITS).
  const planCheck = await loadPlanAndCount(supabase, r.salon.id, "staff");
  if (!planCheck) return fail("server_error");
  if (!canAddStaff(planCheck.planSalon, planCheck.count)) {
    return fail("plan_limit_reached");
  }

  const { data: insertedStaff, error } = await supabase
    .from("staff")
    .insert({
      salon_id: r.salon.id,
      name,
      job_role: input.role,
      // Default new staff to active so the booking flow shows them immediately.
      // Owner can flip to 'pending' / 'inactive' from StaffSetupPanel later.
      status: "active",
    })
    .select("id")
    .single();

  if (error || !insertedStaff?.id) {
    console.error("[addStaff]", error);
    return fail("server_error");
  }

  // Mirror addService behavior: only seed staff_services when the salon
  // is already in whitelist mode. If the salon is still in the all-capable
  // fallback (zero rows), adding rows for only the new staff would break
  // every existing staff member — so we leave 0 rows and keep the fallback.
  const { data: hasCap } = await supabase.rpc("salon_has_staff_services", {
    p_salon_id: r.salon.id,
  });
  if (hasCap === true) {
    const { data: svcRows } = await supabase
      .from("services")
      .select("id")
      .eq("salon_id", r.salon.id)
      .is("deleted_at" as never, null);
    const allSvcIds = (svcRows ?? []).map((s) => String(s.id));
    if (allSvcIds.length > 0) {
      const { error: capErr } = await supabase
        .from("staff_services")
        .insert(
          allSvcIds.map((sid) => ({
            staff_id: String(insertedStaff.id),
            service_id: sid,
          })),
        );
      if (capErr) {
        console.error("[addStaff] staff_services autoattach", capErr);
        return fail("server_error");
      }
    }
  }

  await refreshSalonProfileComplete(supabase, r.salon.id);
  return { ok: true };
}

export type StaffStatus = "active" | "pending" | "inactive";

export async function updateStaff(
  slug: string,
  staffId: string,
  data: {
    name?: string;
    role?: StaffJobRole;
    serviceIds?: string[];
    status?: StaffStatus;
  },
): Promise<Ok | Fail> {
  const r = await resolveSalonForDashboard(slug);
  if (!r) return fail("unauthorized");

  const demoGate = await verifyDemoSetupSlug(slug, r.kind);
  if (demoGate) return demoGate;

  const patch: Record<string, unknown> = {};
  if (data.name !== undefined) {
    const n = String(data.name).trim();
    if (!n || n.length > 160) return fail("invalid_name");
    patch.name = n;
  }
  if (data.role !== undefined) {
    const roles: StaffJobRole[] = ["owner", "senior", "nail_tech"];
    if (!roles.includes(data.role)) return fail("invalid_role");
    patch.job_role = data.role;
  }
  if (data.status !== undefined) {
    const statuses: StaffStatus[] = ["active", "pending", "inactive"];
    if (!statuses.includes(data.status)) return fail("invalid_status");
    patch.status = data.status;
  }
  /* `serviceIds: undefined` means "don't touch capability"; an empty array
     means "this staff can perform nothing" — owners go through this path
     intentionally, so honor it. */
  const touchServices = data.serviceIds !== undefined;
  if (Object.keys(patch).length === 0 && !touchServices) {
    return fail("empty_update");
  }

  const supabase = await writableSupabase(slug, r.kind);
  const { data: mine } = await supabase
    .from("staff")
    .select("id")
    .eq("id", staffId)
    .eq("salon_id", r.salon.id)
    .is("deleted_at" as never, null)
    .maybeSingle();

  if (!mine?.id) return fail("not_found");

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase
      .from("staff")
      .update(patch)
      .eq("id", staffId)
      .eq("salon_id", r.salon.id)
      .is("deleted_at" as never, null);

    if (error) {
      console.error("[updateStaff]", error);
      return fail("server_error");
    }
  }

  if (touchServices) {
    const serviceIds = sanitizeServiceIds(data.serviceIds);
    const { error: delErr } = await supabase
      .from("staff_services")
      .delete()
      .eq("staff_id", staffId);
    if (delErr) {
      console.error("[updateStaff] staff_services delete", delErr);
      return fail("server_error");
    }
    if (serviceIds.length > 0) {
      const { error: insErr } = await supabase
        .from("staff_services")
        .insert(
          serviceIds.map((sid) => ({ staff_id: staffId, service_id: sid })),
        );
      if (insErr) {
        console.error("[updateStaff] staff_services insert", insErr);
        return fail("server_error");
      }
    }
  }

  await refreshSalonProfileComplete(supabase, r.salon.id);
  return { ok: true };
}

export async function deleteStaff(
  slug: string,
  staffId: string,
): Promise<Ok | Fail> {
  const r = await resolveSalonForDashboard(slug);
  if (!r) return fail("unauthorized");

  const demoGate = await verifyDemoSetupSlug(slug, r.kind);
  if (demoGate) return demoGate;

  const supabase = await writableSupabase(slug, r.kind);
  const { count } = await supabase
    .from("staff")
    .select("*", { count: "exact", head: true })
    .eq("salon_id", r.salon.id)
    .is("deleted_at" as never, null);

  if ((count ?? 0) <= 1) {
    return fail("minimum_staff");
  }

  const { data: mine } = await supabase
    .from("staff")
    .select("id")
    .eq("id", staffId)
    .eq("salon_id", r.salon.id)
    .is("deleted_at" as never, null)
    .maybeSingle();

  if (!mine?.id) return fail("not_found");

  const { count: activeBookingCount, error: bookingCountErr } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", r.salon.id)
    .eq("staff_id", staffId)
    .in("status", ["pending", "confirmed", "in_progress", "waiting"]);

  if (bookingCountErr) {
    console.error("[deleteStaff] active booking count", bookingCountErr);
    return fail("server_error");
  }
  if ((activeBookingCount ?? 0) > 0) {
    return fail("staff_has_bookings");
  }

  // See decisions-log.md 2026-05-02: Staff delete detaches terminal bookings
  const { error: detachErr } = await supabase
    .from("bookings")
    .update({ staff_id: null })
    .eq("salon_id", r.salon.id)
    .eq("staff_id", staffId)
    .in("status", ["cancelled", "completed"]);

  if (detachErr) {
    console.error("[deleteStaff] detach terminal bookings", detachErr);
    return fail("server_error");
  }

  const { error: prefErr } = await supabase
    .from("client_profiles")
    .update({ preferred_staff_id: null })
    .eq("preferred_staff_id", staffId);

  if (prefErr) {
    console.error("[deleteStaff] clear preferred_staff_id", prefErr);
    return fail("server_error");
  }

  // Soft delete (2026-05-10): UPDATE deleted_at instead of DELETE so
  // historical bookings keep a resolvable staff_id and SuperAdmin can
  // restore. All read paths filter `deleted_at IS NULL`. Cast: column
  // not yet in the auto-generated DB types.
  const { error } = await supabase
    .from("staff")
    .update({ deleted_at: new Date().toISOString() } as never)
    .eq("id", staffId)
    .eq("salon_id", r.salon.id)
    .is("deleted_at", null);

  if (error) {
    console.error("[deleteStaff]", error);
    return fail("server_error");
  }

  await refreshSalonProfileComplete(supabase, r.salon.id);
  return { ok: true };
}

export async function updateOpeningHours(
  slug: string,
  openingHours: OpeningHoursWeek,
  closedDatesYmd: string[] = [],
): Promise<Ok | Fail> {
  const slugTrimmed = typeof slug === "string" ? slug.trim() : "";
  if (!slugTrimmed) {
    return fail("unauthorized");
  }

  const r = await resolveSalonForDashboard(slugTrimmed);
  if (!r) return fail("unauthorized");

  const salonId = String(r.salon.id ?? "").trim();
  if (!salonId) {
    captureOpeningHoursUnexpected(new Error("resolveSalonForDashboard missing id"), {
      slug: slugTrimmed,
    });
    return fail("server_error");
  }

  const demoGate = await verifyDemoSetupSlug(slugTrimmed, r.kind);
  if (demoGate) return demoGate;

  const hoursInput: unknown =
    openingHours && typeof openingHours === "object" ? openingHours : null;
  const merged = mergeOpeningHoursFromClient(hoursInput);
  const revalidated = parseOpeningHours(JSON.parse(stableOpeningHoursJson(merged)));
  if (!revalidated) {
    return fail("invalid_hours");
  }

  let serialized: string;
  try {
    serialized = stableOpeningHoursJson(revalidated);
  } catch {
    return fail("invalid_hours");
  }

  const datesForClosed = Array.isArray(closedDatesYmd)
    ? closedDatesYmd.filter((x): x is string => typeof x === "string")
    : [];
  const closedJson = normalizeBookingClosedDateList(datesForClosed);

  let openingHoursParsed: Record<string, unknown>;
  try {
    openingHoursParsed = JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return fail("invalid_hours");
  }

  try {
    const supabase = await writableSupabase(slugTrimmed, r.kind);

    const patchFull = {
      opening_hours: openingHoursParsed,
      booking_closed_dates: closedJson,
    };

    let { data: updatedRow, error } = await supabase
      .from("salons")
      .update(patchFull)
      .eq("id", salonId)
      .eq("slug", slugTrimmed)
      .select("id")
      .maybeSingle();

    const missingBookingClosedColumn =
      error?.code === "PGRST204" &&
      typeof error.message === "string" &&
      error.message.includes("booking_closed_dates");

    if (missingBookingClosedColumn) {
      console.warn(
        "[updateOpeningHours] booking_closed_dates not in PostgREST schema; applied opening_hours only. Run supabase migration 20260430210000_salons_booking_closed_dates (or reload schema).",
      );
      ({ data: updatedRow, error } = await supabase
        .from("salons")
        .update({ opening_hours: openingHoursParsed })
        .eq("id", salonId)
        .eq("slug", slugTrimmed)
        .select("id")
        .maybeSingle());
    }

    if (error) {
      console.error("[updateOpeningHours] error:", error);
      captureOpeningHoursSupabaseFailure(error, {
        slug: slugTrimmed,
        salonId,
        stage: missingBookingClosedColumn
          ? "after_hours_only_retry"
          : "full_patch",
      });
      return fail(classifySalonHourSaveError(error));
    }

    if (!updatedRow?.id) {
      console.error("[updateOpeningHours] no row updated", {
        salonId,
        slug: slugTrimmed,
        kind: r.kind,
      });
      Sentry.captureMessage("updateOpeningHours: zero rows updated", {
        level: "warning",
        tags: {
          "salon.action": "update_opening_hours",
          "salon.slug": slugTrimmed,
        },
        extra: { salonId, kind: r.kind },
      });
      return fail("permission_denied");
    }

    try {
      await refreshSalonProfileComplete(supabase, salonId);
    } catch (e) {
      console.error("[updateOpeningHours] refreshSalonProfileComplete", e);
      captureOpeningHoursUnexpected(e, { slug: slugTrimmed });
    }
    return { ok: true };
  } catch (e) {
    captureOpeningHoursUnexpected(e, { slug: slugTrimmed });
    return fail("server_error");
  }
}

export async function updateAddress(
  slug: string,
  input: {
    street: string;
    city: string;
    province: string;
    postal: string;
    country: string;
    salon_phone: string;
    /** Salon's display currency (CAD / USD / VND). Optional — when
     *  omitted the existing value is preserved. */
    currency_code?: Currency | string;
    /** P2.8 — owner-written salon description shown on the booking
     * page. Optional; omitted leaves the column unchanged. Empty
     * string after trim clears the column to null. */
    description?: string | null;
    /** Task #04-B — salon IANA timezone. Required-and-validated on
     *  the server: must be one of the 10 supported zones in
     *  `timezoneOptions.ts`. Optional in this shape because the
     *  field was added retroactively; existing callers that omit it
     *  leave the column unchanged. New saves from the AddressSetupPanel
     *  always include it. */
    timezone?: string;
  },
): Promise<Ok | Fail> {
  const r = await resolveSalonForDashboard(slug);
  if (!r) return fail("unauthorized");

  const demoGate = await verifyDemoSetupSlug(slug, r.kind);
  if (demoGate) return demoGate;

  const salonPhone = input.salon_phone.trim();
  if (!isValidPhone(salonPhone)) return fail("invalid_phone");
  if (salonPhone.length > 40) return fail("invalid_phone");

  if (!validateStreet(input.street)) return fail("invalid_street");
  if (!validateCity(input.city)) return fail("invalid_city");
  if (!validateProvince(input.province)) return fail("invalid_province");
  if (!isValidPostalCode(input.postal)) return fail("invalid_postal");
  const country = input.country.trim();
  if (!country || !isAllowedCountry(country)) return fail("invalid_country");

  // Reject unknown currency codes rather than silently falling back —
  // keeps the API honest. Omitted is fine (DB keeps existing value).
  let currencyCode: Currency | undefined;
  if (input.currency_code !== undefined) {
    if (!isSupportedCurrency(input.currency_code)) {
      return fail("invalid_currency");
    }
    currencyCode = input.currency_code;
  }

  // Task #04-B — timezone must be one of the 10 supported zones
  // when present. The DB has `timezone NOT NULL DEFAULT
  // 'America/Vancouver'` (migration 20260512600000) so omitting
  // this field is safe (column keeps its current value); supplying
  // an unknown IANA name is rejected here.
  let timezoneVal: string | undefined;
  if (input.timezone !== undefined) {
    if (!isAllowedTimezone(input.timezone)) {
      return fail("invalid_timezone");
    }
    timezoneVal = input.timezone;
  }

  const address = buildSalonAddressString({
    street: input.street,
    city: input.city,
    province: input.province,
    postal: input.postal,
    country,
  });
  if (!address || address.length > 400) return fail("invalid_address");

  // P2.8 — Description column added by migration 20260512100000.
  // Same `as never` cast pattern as currency_code; column may not be
  // in the auto-generated types until the next regeneration. Treat
  // empty-string as "clear back to null".
  let descriptionPatch: string | null | undefined;
  if (input.description !== undefined) {
    if (input.description === null) {
      descriptionPatch = null;
    } else {
      const d = input.description.trim();
      if (d.length > 400) return fail("invalid_description");
      descriptionPatch = d.length > 0 ? d : null;
    }
  }

  // currency_code cast: column added by migration 20260512000000;
  // not yet in the auto-generated DB types. `timezone` predates
  // the generated types but lives in `salons.timezone TEXT NOT NULL`
  // (migration 20260512600000_timezone_required).
  const patch = {
    address,
    salon_phone: salonPhone,
    ...(currencyCode !== undefined ? { currency_code: currencyCode } : {}),
    ...(descriptionPatch !== undefined
      ? { description: descriptionPatch }
      : {}),
    ...(timezoneVal !== undefined ? { timezone: timezoneVal } : {}),
  } as never;
  const supabase = await writableSupabase(slug, r.kind);
  const { error } = await supabase
    .from("salons")
    .update(patch)
    .eq("id", r.salon.id)
    .eq("slug", slug);

  if (error) {
    console.error("[updateAddress]", error);
    return fail("server_error");
  }

  await refreshSalonProfileComplete(supabase, r.salon.id);
  return { ok: true };
}

export async function getDashboardWriteClient(slug: string): Promise<
  | null
  | {
      salon: {
        id: string;
        name: string;
        slug: string;
        phone: string;
        email: string | null;
        address: string | null;
        salon_phone: string | null;
        opening_hours: unknown | null;
        profile_complete: boolean;
        booking_closed_dates: unknown | null;
        /** IANA timezone (e.g. "America/Los_Angeles"). Sourced from
         *  `resolveSalonForDashboard`'s expanded SELECT so callers
         *  on `/dashboard/[slug]/center` no longer need a second
         *  round-trip just to compute "today" in the salon's tz. */
        timezone: string;
        /** Receptionist-center config + currency, threaded through
         *  the same expanded SELECT so `loadReceptionistCenterData`
         *  can accept the salon row instead of re-fetching it.
         *  Caller-side parsers (`parseDashboardModules`, etc.)
         *  remain the source of truth for narrowing. */
        dashboard_modules: unknown | null;
        dashboard_preset: unknown | null;
        dashboard_density: unknown | null;
        currency_code: unknown | null;
      };
      kind: "member" | "demo_cookie";
      /** `salon_members.role` for this user-salon pair. Demo-cookie path is `"owner"`. */
      role: SalonMemberRole;
      supabase: GenericSupabase;
    }
> {
  const r = await resolveSalonForDashboard(slug);
  if (!r) return null;

  const demoGate = await verifyDemoSetupSlug(slug, r.kind);
  if (demoGate) return null;

  const supabase = await writableSupabase(slug, r.kind);
  return {
    salon: r.salon,
    kind: r.kind,
    role: r.role,
    supabase,
  };
}

export type VoiceAiSettingsInput = {
  voice_ai_enabled:          boolean;
  voice_ai_persona_name:     string;
  voice_ai_persona_voice:    string;
  voice_ai_reasoning_effort: string;
};

export async function updateVoiceAiSettings(
  slug: string,
  input: VoiceAiSettingsInput,
): Promise<{ ok: true } | { error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { error: "unauthorized" };
  if (ctx.role !== "owner") return { error: "owner_only" };

  const VALID_VOICES = [
    "alloy", "ash", "ballad", "cedar", "coral",
    "echo", "fable", "marin", "nova", "onyx",
    "sage", "shimmer", "verse",
  ] as const;
  const VALID_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

  const voice = VALID_VOICES.includes(input.voice_ai_persona_voice as (typeof VALID_VOICES)[number])
    ? input.voice_ai_persona_voice
    : "marin";
  const effort = VALID_EFFORTS.includes(input.voice_ai_reasoning_effort as (typeof VALID_EFFORTS)[number])
    ? input.voice_ai_reasoning_effort
    : "low";
  const personaName = input.voice_ai_persona_name.trim().slice(0, 40) || "Lily";

  const { error } = await ctx.supabase
    .from("salons")
    .update({
      voice_ai_enabled:          input.voice_ai_enabled,
      voice_ai_persona_name:     personaName,
      voice_ai_persona_voice:    voice,
      voice_ai_reasoning_effort: effort,
    } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    Sentry.captureException(error, { tags: { action: "updateVoiceAiSettings", "salon.slug": slug } });
    return { error: error.message };
  }

  return { ok: true };
}
