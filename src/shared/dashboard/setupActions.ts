"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  resolveSalonForDashboard,
} from "@/shared/dashboard/salonOwnerActions";
import {
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

export type StaffJobRole = "owner" | "senior" | "nail_tech";

async function writableSupabase(
  kind: "member" | "demo_cookie",
): Promise<
  Awaited<ReturnType<typeof createClient>> | ReturnType<typeof createServiceRoleClient>
> {
  if (kind === "demo_cookie") {
    return createServiceRoleClient();
  }
  return createClient();
}

type GenericSupabase = Awaited<ReturnType<typeof createClient>>;

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

  const name = input.name.trim();
  if (!name || name.length > 160) return fail("invalid_name");

  const price = Math.round(Number(input.price_cents));
  const duration = Math.round(Number(input.duration_minutes));
  const buffer = Math.round(Number(input.buffer_minutes));
  if (!Number.isFinite(price) || price < 0) return fail("invalid_price");
  if (!Number.isFinite(duration) || duration < 1)
    return fail("invalid_duration");
  if (!Number.isFinite(buffer) || buffer < 0) return fail("invalid_buffer");

  const supabase = await writableSupabase(r.kind);
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

  const supabase = await writableSupabase(r.kind);
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

  const supabase = await writableSupabase(r.kind);
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
      return fail("in_use");
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

  const name = input.name.trim();
  if (!name || name.length > 160) return fail("invalid_name");
  const roles: StaffJobRole[] = ["owner", "senior", "nail_tech"];
  if (!roles.includes(input.role)) return fail("invalid_role");

  const supabase = await writableSupabase(r.kind);
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

  const supabase = await writableSupabase(r.kind);
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

  const supabase = await writableSupabase(r.kind);
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
      return fail("in_use");
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
  const r = await resolveSalonForDashboard(slug);
  if (!r) return fail("unauthorized");

  let serialized: string;
  try {
    serialized = stableOpeningHoursJson(openingHours);
  } catch {
    return fail("invalid_hours");
  }

  const closedJson = normalizeBookingClosedDateList(closedDatesYmd);

  const supabase = await writableSupabase(r.kind);
  const { error } = await supabase
    .from("salons")
    .update({
      opening_hours: JSON.parse(serialized) as Record<string, unknown>,
      booking_closed_dates: closedJson,
    })
    .eq("id", r.salon.id)
    .eq("slug", slug);

  if (error) {
    console.error("[updateOpeningHours]", error);
    return fail("server_error");
  }

  await refreshSalonProfileComplete(supabase, r.salon.id);
  return { ok: true };
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

  const supabase = await writableSupabase(r.kind);
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
  const supabase = await writableSupabase(r.kind);
  return {
    salon: r.salon,
    kind: r.kind,
    supabase,
  };
}
