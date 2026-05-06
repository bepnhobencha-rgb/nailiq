import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl?.trim() || !serviceKey?.trim()) {
  throw new Error(
    "e2e/helpers/db requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.test.local)",
  );
}

const supabase = createClient(supabaseUrl, serviceKey);

export async function getLatestOtp(phone: string): Promise<string> {
  const { data } = await supabase
    .from("otps")
    .select("code")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.code ?? "";
}

export async function cleanupTestSalon(slug: string) {
  const { data: salon } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();

  if (!salon?.id) return;

  const salonId = salon.id as string;

  await supabase.from("bookings").delete().eq("salon_id", salonId);
  await supabase.from("booking_waitlist_entries").delete().eq("salon_id", salonId);

  const { data: staffRows } = await supabase
    .from("staff")
    .select("id")
    .eq("salon_id", salonId);

  const staffIds = (staffRows ?? [])
    .map((s: { id?: string }) => s.id)
    .filter((id): id is string => Boolean(id));

  if (staffIds.length > 0) {
    await supabase
      .from("client_profiles")
      .update({ preferred_staff_id: null })
      .in("preferred_staff_id", staffIds);
  }

  await supabase.from("salon_members").delete().eq("salon_id", salonId);
  await supabase.from("services").delete().eq("salon_id", salonId);
  await supabase.from("staff").delete().eq("salon_id", salonId);
  await supabase.from("salons").delete().eq("id", salonId);
}

export async function seedTestSalon(opts?: {
  phone?: string;
  slug?: string;
  name?: string;
  /** `salons.salon_phone` — public line for reschedule CTA; omit or null for none. */
  salon_phone?: string | null;
}) {
  const phone = opts?.phone ?? "15550001111";
  const slug = opts?.slug ?? "e2e-test-salon";
  const name = opts?.name ?? "E2E Test Salon";

  await cleanupTestSalon(slug);

  const { data: salon, error: salonErr } = await supabase
    .from("salons")
    .insert({
      slug,
      name,
      phone,
      profile_complete: true,
      salon_phone:
        opts?.salon_phone === undefined
          ? null
          : opts.salon_phone === null || opts.salon_phone === ""
            ? null
            : String(opts.salon_phone).trim() || null,
    })
    .select("id")
    .single();

  if (salonErr || !salon?.id) {
    throw new Error(salonErr?.message ?? "seedTestSalon: failed to insert salon");
  }

  const { data: svcRows, error: svcErr } = await supabase
    .from("services")
    .insert([
      {
        salon_id: salon.id,
        name: "Gel Manicure",
        price_cents: 4500,
        duration_minutes: 45,
        buffer_minutes: 10,
      },
    ])
    .select("id");

  if (svcErr) {
    await supabase.from("salons").delete().eq("id", salon.id);
    throw new Error(svcErr.message);
  }

  const { data: staffRows, error: staffErr } = await supabase
    .from("staff")
    .insert([{ salon_id: salon.id, name: "Jenny", job_role: "nail_tech" }])
    .select("id");

  if (staffErr) {
    await supabase.from("services").delete().eq("salon_id", salon.id);
    await supabase.from("salons").delete().eq("id", salon.id);
    throw new Error(staffErr.message);
  }

  // PR #7 staff_services: empty whitelist == all-capable fallback, but
  // seeding the cross-product makes the assign capability gate behave the
  // same on test salons as on real salons that have completed setup.
  const serviceIds = (svcRows ?? [])
    .map((r: { id?: string }) => r.id)
    .filter((id): id is string => Boolean(id));
  const staffIds = (staffRows ?? [])
    .map((r: { id?: string }) => r.id)
    .filter((id): id is string => Boolean(id));

  const capabilityRows = staffIds.flatMap((staff_id) =>
    serviceIds.map((service_id) => ({ staff_id, service_id })),
  );

  if (capabilityRows.length > 0) {
    const { error: capErr } = await supabase
      .from("staff_services")
      .insert(capabilityRows);
    if (capErr) {
      await supabase.from("staff").delete().eq("salon_id", salon.id);
      await supabase.from("services").delete().eq("salon_id", salon.id);
      await supabase.from("salons").delete().eq("id", salon.id);
      throw new Error(capErr.message);
    }
  }

  return { salonId: salon.id as string, slug, phone };
}
