import { createClient } from "@supabase/supabase-js";
import type { Locator, Page } from "@playwright/test";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl?.trim() || !serviceKey?.trim()) {
  throw new Error(
    "e2e/helpers/db requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.test.local)",
  );
}

const supabase = createClient(supabaseUrl, serviceKey);

// Public booking calendar (rewritten 2026-05-12) gates each selectable day cell
// on `salons.opening_hours` via parseOpeningHours(): a NULL value parses to null
// and BookingCalendarGrid then marks EVERY weekday closed — so the date step has
// no clickable day and the whole public-booking suite times out waiting for
// `[data-testid="date-day"]:not([disabled])`. Real salons get hours from the
// setup wizard; direct-insert seeds must set them explicitly. Mirrors the
// canonical DEFAULT_OPENING_HOURS_JSON (Mon–Sat 09:00–18:00 open, Sun closed —
// the Sun-closed default is exactly what group-booking/no-slots.spec asserts).
const SEED_OPENING_HOURS = {
  mon: { open: "09:00", close: "18:00", closed: false },
  tue: { open: "09:00", close: "18:00", closed: false },
  wed: { open: "09:00", close: "18:00", closed: false },
  thu: { open: "09:00", close: "18:00", closed: false },
  fri: { open: "09:00", close: "18:00", closed: false },
  sat: { open: "09:00", close: "18:00", closed: false },
  sun: { open: "09:00", close: "18:00", closed: true },
} as const;

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

  // Wait for the slug to actually disappear on a fresh PostgREST read.
  // Without this barrier, an immediately-following INSERT with the same
  // slug can race the delete's commit visibility — the seed's new salon
  // succeeds, but a concurrent late-arriving CASCADE from this delete
  // wipes it out (manifesting as `bookings_salon_id_fkey` violations
  // from the seed's first booking insert when staff/service rows were
  // CASCADE-deleted alongside the new salon).
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { count } = await supabase
      .from("salons")
      .select("*", { count: "exact", head: true })
      .eq("slug", slug);
    if ((count ?? 0) === 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Remove a guest's `client_profiles` row by phone.
 *
 * `client_profiles` has NO `salon_id` (it's a cross-salon guest record keyed on
 * a unique phone), so `cleanupTestSalon` cannot reach it. Completed bookings
 * bump `visit_count`; once a reused test phone hits visit_count >= 5 with zero
 * no-shows, `determine_booking_verification` returns action:"none"
 * reason:"trusted_returning" and SKIPS the OTP step even for an `always_otp`
 * salon — which silently broke the booking-otp E2E suite over time. Callers that
 * reuse or assert on a specific guest phone must reset it here.
 *
 * Safe for fresh per-test phones: the only inbound FK is
 * `loyalty_cards.client_profile_id` (ON DELETE NO ACTION), and a brand-new
 * guest phone has no loyalty card, so the delete never violates it. Matches the
 * digits-only form the verify-decision route normalises to
 * (`client_phone.replace(/\D/g, "")`), plus a leading-1 variant in case a
 * caller stored the 11-digit NANP form.
 */
export async function cleanupClientProfile(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return;
  const variants = digits.length === 10 ? [digits, `1${digits}`] : [digits];
  await supabase.from("client_profiles").delete().in("phone", variants);
}

export async function seedTestSalon(opts?: {
  phone?: string;
  slug?: string;
  name?: string;
  /** `salons.salon_phone` — public line for reschedule CTA; omit or null for none. */
  salon_phone?: string | null;
  phone_otp_enabled?: boolean;
  /**
   * `salons.booking_verification_mode` — controls whether OTP / deposit friction is
   * applied. Defaults to 'never' (no friction). Set to 'always_otp' for OTP tests.
   */
  booking_verification_mode?: "never" | "always_otp" | "auto" | "always_deposit" | "deposit_first";
  /**
   * `salons.feature_flags` JSONB overrides. PR2 gates Beta release features
   * (e.g. group_booking) which default OFF — specs that exercise a Beta surface
   * must enable its flag here, e.g. `{ group_booking_enabled: true }`.
   */
  feature_flags?: Record<string, boolean>;
  /**
   * `salons.voice_ai_enabled` COLUMN — the per-salon store for the `ai_voice`
   * Beta release feature (PR3 gates `/dashboard/[slug]/setup/voice` on it).
   * Unlike the other Beta flags this is a dedicated boolean column, NOT a
   * `feature_flags` jsonb key. Omit (or pass undefined) to leave the column at
   * its DB default — `ai_voice` then resolves to its Beta default (OFF). Pass
   * `true` to enable the Voice AI setup route.
   */
  voice_ai_enabled?: boolean;
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
      opening_hours: SEED_OPENING_HOURS,
      feature_flags: opts?.feature_flags ?? {},
      // Only write the column when the caller opts in. Leaving it unset keeps
      // the DB default so `ai_voice` resolves to its Beta default (OFF) — the
      // route-gating OFF case must not depend on an explicit false here.
      ...(opts?.voice_ai_enabled === undefined
        ? {}
        : { voice_ai_enabled: opts.voice_ai_enabled }),
      setup_wizard_completed_at: new Date().toISOString(),
      salon_phone:
        opts?.salon_phone === undefined
          ? null
          : opts.salon_phone === null || opts.salon_phone === ""
            ? null
            : String(opts.salon_phone).trim() || null,
      phone_otp_enabled: opts?.phone_otp_enabled ?? false,
      booking_verification_mode: opts?.booking_verification_mode ?? "never",
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

/**
 * Seed a minimal salon with no services and no staff — used by AI Prefill
 * wizard tests which need a 0-service starting state.
 */
export async function seedEmptyTestSalon(opts?: {
  phone?: string;
  slug?: string;
  name?: string;
}) {
  const phone = opts?.phone ?? "15550002222";
  const slug = opts?.slug ?? "e2e-ai-prefill-salon";
  const name = opts?.name ?? "E2E AI Prefill Salon";

  await cleanupTestSalon(slug);

  const { data: salon, error: salonErr } = await supabase
    .from("salons")
    .insert({
      slug,
      name,
      phone,
      profile_complete: false,
      setup_wizard_completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (salonErr || !salon?.id) {
    throw new Error(
      salonErr?.message ?? "seedEmptyTestSalon: failed to insert salon",
    );
  }

  return { salonId: salon.id as string, slug, phone };
}

/**
 * Create a Supabase auth user for E2E tests that exercise email/password sign-in.
 * Uses the service-role admin API so no real email is sent.
 * Returns { userId, email, password }.
 */
export async function seedTestUser(opts?: { email?: string; password?: string }) {
  const email = opts?.email ?? `e2e-user-${Date.now()}@nailiq.test.invalid`;
  const password = opts?.password ?? "E2E_testpass_2026!";

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user?.id) {
    throw new Error(error?.message ?? "seedTestUser: failed to create auth user");
  }

  return { userId: data.user.id, email, password };
}

/** Remove a Supabase auth user (and any salon they own) from E2E test runs. */
export async function cleanupTestUser(userId: string) {
  // Remove salon_members first to find any salon owned by this user.
  const { data: memberRows } = await supabase
    .from("salon_members")
    .select("salon_id")
    .eq("user_id", userId)
    .eq("role", "owner");

  for (const row of memberRows ?? []) {
    const salonId = (row as { salon_id: string }).salon_id;
    await supabase.from("bookings").delete().eq("salon_id", salonId);
    await supabase.from("services").delete().eq("salon_id", salonId);
    await supabase.from("staff").delete().eq("salon_id", salonId);
    await supabase.from("salon_members").delete().eq("salon_id", salonId);
    await supabase.from("salons").delete().eq("id", salonId);
  }

  await supabase.auth.admin.deleteUser(userId);
}

/**
 * A valid phone for the phone-first entry gate (PR #328). Kept as a NEW
 * customer (no client_profile) so the info step's name field stays empty.
 */
export const GATE_PHONE_DIGITS = "16045550000";
export const GATE_PHONE = `+${GATE_PHONE_DIGITS}`;

/**
 * Set a controlled React input's value via the native setter + a bubbling
 * InputEvent. Playwright's `locator.fill()` drives the value over CDP, which
 * bypasses React's patched value setter on WebKit (the mobile project), so the
 * input's onChange never fires. Use this for any input whose onChange must run
 * (e.g. the phone-first entry gate, which only mounts the flow once a valid
 * phone lands).
 */
export async function setReactInputValue(
  locator: Locator,
  value: string,
): Promise<void> {
  await locator.evaluate((el: HTMLInputElement, val: string) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (nativeSetter) nativeSetter.call(el, val);
    else el.value = val;
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true }),
    );
  }, value);
}

/**
 * Navigate to a salon's public booking page and clear the phone-first entry
 * gate so the individual booking flow mounts and the service step renders.
 * Mirrors `gotoGroupFlow` for the non-group (individual) flow: the service
 * tiles only exist once a valid phone is entered at the gate.
 */
export async function gotoBookingServiceStep(
  page: Page,
  slug: string,
): Promise<void> {
  // Keep the gate phone a NEW customer so the info-step name stays default.
  await supabase.from("client_profiles").delete().eq("phone", GATE_PHONE_DIGITS);
  await page.goto(`/${slug}`);
  const phoneInput = page.getByTestId("booking-entry-phone");
  await phoneInput.waitFor({ state: "visible", timeout: 15_000 });
  await setReactInputValue(phoneInput, GATE_PHONE);
  await page
    .locator('[data-testid="service-tile-select"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
}
