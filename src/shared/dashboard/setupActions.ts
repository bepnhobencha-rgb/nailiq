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
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";

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

  if (kind === "demo_cookie") {
    return createServiceRoleClient();
  }

  if (isDemoOtpRuntime() && demoSlug === slug) {
    return createServiceRoleClient();
  }

  return createClient();
}

/** Demo OTP runtime + non-member path requires cookie salon to match slug. Members use JWT + RLS. */
async function verifyDemoSetupSlug(
  slug: string,
  kind: "member" | "demo_cookie",
): Promise<Fail | null> {
  const isDemo = isDemoOtpRuntime();
  if (!isDemo) return null;

  const demoSlug =
    (await cookies()).get(NAILQ_DEMO_SLUG_COOKIE)?.value ?? null;

  if (demoSlug !== slug && kind !== "member") {
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

  const { count: sc } = await supabase
    .from("services")
    .select("*", { count: "exact", head: true })
    .eq("salon_id", salonId);

  const { count: tc } = await supabase
    .from("staff")
    .select("*", { count: "exact", head: true })
    .eq("salon_id", salonId);

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
type Ok = { ok: true };

function fail(msg: string): Fail {
  return { ok: false, error: msg };
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

  const supabase = await writableSupabase(slug, r.kind);
  const { error } = await supabase.from("services").insert({
    salon_id: r.salon.id,
    name,
    price_cents: price,
    duration_minutes: duration,
    buffer_minutes: buffer,
  });

  if (error) {
    console.error("[addService]", error);
    return fail("server_error");
  }

  await refreshSalonProfileComplete(supabase, r.salon.id);
  return { ok: true };
}

export async function updateService(
  slug: string,
  serviceId: string,
  data: Partial<{
    name: string;
    price_cents: number;
    duration_minutes: number;
    buffer_minutes: number;
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

  if (Object.keys(patch).length === 0) return fail("empty_update");

  const supabase = await writableSupabase(slug, r.kind);
  const { data: mine, error: fetchErr } = await supabase
    .from("services")
    .select("id")
    .eq("id", serviceId)
    .eq("salon_id", r.salon.id)
    .maybeSingle();

  if (fetchErr || !mine?.id) {
    return fail("not_found");
  }

  const { error } = await supabase
    .from("services")
    .update(patch)
    .eq("id", serviceId)
    .eq("salon_id", r.salon.id);

  if (error) {
    console.error("[updateService]", error);
    return fail("server_error");
  }

  await refreshSalonProfileComplete(supabase, r.salon.id);
  return { ok: true };
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
    .eq("salon_id", r.salon.id);

  if (cErr || (count ?? 0) <= 1) {
    return fail("minimum_services");
  }

  const { data: mine } = await supabase
    .from("services")
    .select("id")
    .eq("id", serviceId)
    .eq("salon_id", r.salon.id)
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

  const { error } = await supabase
    .from("services")
    .delete()
    .eq("id", serviceId)
    .eq("salon_id", r.salon.id);

  if (error) {
    console.error("[deleteService]", error);
    if (
      typeof error.code === "string" &&
      error.code === "23503"
    ) {
      return fail("service_in_use");
    }
    return fail("server_error");
  }

  await refreshSalonProfileComplete(supabase, r.salon.id);
  return { ok: true };
}

export async function addStaff(
  slug: string,
  input: { name: string; role: StaffJobRole },
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
  const { error } = await supabase.from("staff").insert({
    salon_id: r.salon.id,
    name,
    job_role: input.role,
  });

  if (error) {
    console.error("[addStaff]", error);
    return fail("server_error");
  }

  await refreshSalonProfileComplete(supabase, r.salon.id);
  return { ok: true };
}

export async function updateStaff(
  slug: string,
  staffId: string,
  data: { name?: string; role?: StaffJobRole },
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
  if (Object.keys(patch).length === 0) return fail("empty_update");

  const supabase = await writableSupabase(slug, r.kind);
  const { data: mine } = await supabase
    .from("staff")
    .select("id")
    .eq("id", staffId)
    .eq("salon_id", r.salon.id)
    .maybeSingle();

  if (!mine?.id) return fail("not_found");

  const { error } = await supabase
    .from("staff")
    .update(patch)
    .eq("id", staffId)
    .eq("salon_id", r.salon.id);

  if (error) {
    console.error("[updateStaff]", error);
    return fail("server_error");
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
    .eq("salon_id", r.salon.id);

  if ((count ?? 0) <= 1) {
    return fail("minimum_staff");
  }

  const { data: mine } = await supabase
    .from("staff")
    .select("id")
    .eq("id", staffId)
    .eq("salon_id", r.salon.id)
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

  const { error } = await supabase
    .from("staff")
    .delete()
    .eq("id", staffId)
    .eq("salon_id", r.salon.id);

  if (error) {
    console.error("[deleteStaff]", error);
    if (
      typeof error.code === "string" &&
      error.code === "23503"
    ) {
      return fail("staff_has_bookings");
    }
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

  const address = buildSalonAddressString({
    street: input.street,
    city: input.city,
    province: input.province,
    postal: input.postal,
    country,
  });
  if (!address || address.length > 400) return fail("invalid_address");

  const supabase = await writableSupabase(slug, r.kind);
  const { error } = await supabase
    .from("salons")
    .update({ address, salon_phone: salonPhone })
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
      };
      kind: "member" | "demo_cookie";
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
    supabase,
  };
}
