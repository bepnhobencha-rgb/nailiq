import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Locator, Page } from "@playwright/test";

import { assertNotProductionFromEnv } from "./guardProduction";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl?.trim() || !serviceKey?.trim()) {
  throw new Error(
    "e2e/helpers/db requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.test.local)",
  );
}

// This is the module nearly every spec seeds through — salons, staff, services,
// bookings, OTPs — and it holds a service-role client that bypasses RLS.
// globalSetup already guards the Playwright run, but this check is what protects
// the module when it is imported outside the runner (a one-off `tsx` script, a
// helper reused elsewhere). The same reasoning applies here as in
// helpers/superadmin.ts; leaving the busiest write path unguarded would have
// been the obvious hole.
assertNotProductionFromEnv();

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

/**
 * Every group booking row for a salon, with the fields the group side-effect
 * stamp is responsible for.
 *
 * Exists because `submitGroupBooking` runs in the BROWSER for the public flow,
 * where the anon client holds the UPDATE grant on `bookings` but has no RLS
 * UPDATE policy — the write lands on 0 rows and reports no error. That left 168
 * production rows with a null `booking_channel`. A green build proves nothing
 * about this class of bug, so the specs assert the stamp from the DB side.
 *
 * Organizer row first, so callers can read `rows[0]` as the organizer.
 */
export async function getGroupBookingStamps(slug: string): Promise<
  Array<{
    id: string;
    booking_channel: string | null;
    verification_method: string | null;
    otp_session_id: string | null;
    is_group_organizer: boolean | null;
  }>
> {
  const { data: salon } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (!salon) return [];

  const { data } = await supabase
    .from("bookings")
    .select(
      "id, booking_channel, verification_method, otp_session_id, is_group_organizer",
    )
    .eq("salon_id", (salon as { id: string }).id)
    .not("group_id", "is", null)
    .is("deleted_at", null)
    .order("is_group_organizer", { ascending: false });

  return (data ?? []) as Awaited<ReturnType<typeof getGroupBookingStamps>>;
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
 * Seed one reversible, internal-only AI approval for the approval-to-effect E2E.
 * The execution allowlist turns this into an audit note; it cannot contact a
 * customer, change a booking or price, or initiate a payment.
 */
export async function seedOperationalNoteApproval(salonId: string) {
  const summary = "Record the approved staffing review in the operating log.";
  const note = `E2E approved operating note ${randomUUID()}`;
  const { data, error } = await supabase
    .from("approval_requests")
    .insert({
      salon_id: salonId,
      action_type: "record_operational_note",
      summary,
      payload: { note },
      urgency: "normal",
      status: "pending",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    .select("id, approve_token")
    .single();

  if (error || !data?.id || !data.approve_token) {
    throw new Error(
      error?.message ?? "seedOperationalNoteApproval: insert failed",
    );
  }

  return {
    approvalId: data.id as string,
    approveToken: data.approve_token as string,
    summary,
    note,
  };
}

export async function seedBulkMessageApproval(salonId: string) {
  const summary = "Prepare a consent-checked re-engagement audience.";
  const { data, error } = await supabase
    .from("approval_requests")
    .insert({
      salon_id: salonId,
      action_type: "bulk_message",
      summary,
      payload: {
        recipient_selection_required: true,
        segment: "lapsed_regulars_45_365_days",
        message: "We miss you — book your next nail appointment.",
      },
      urgency: "normal",
      status: "pending",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    .select("id, approve_token")
    .single();

  if (error || !data?.id || !data.approve_token) {
    throw new Error(error?.message ?? "seedBulkMessageApproval: insert failed");
  }

  return {
    approvalId: data.id as string,
    approveToken: data.approve_token as string,
    summary,
  };
}

export async function seedCampaignRecipient() {
  const id = randomUUID();
  const suffix = randomBytes(5).toString("hex");
  const { error } = await supabase.from("client_profiles").insert({
    id,
    phone: `1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
    email: `campaign-${suffix}@example.test`,
    marketing_consent_at: new Date().toISOString(),
    marketing_email_consent_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return id;
}

export async function recordTestCampaignManifest(input: {
  salonId: string;
  jobId: string;
  clientProfileId: string;
  sms?: boolean;
  email?: boolean;
}) {
  const now = new Date().toISOString();
  const sms = input.sms ?? true;
  const email = input.email ?? false;
  const audienceKey =
    `${input.clientProfileId}:${sms ? "s" : ""}${email ? "e" : ""}`;
  const fingerprint = createHash("sha256")
    .update(audienceKey)
    .digest("hex")
    .slice(0, 24);
  const { data, error } = await supabase.rpc(
    "record_ai_campaign_manifest" as never,
    {
      p_job_id: input.jobId,
      p_salon_id: input.salonId,
      p_summary: {
        prepared_at: now,
        segment: "lapsed_regulars_45_365_days",
        candidate_count: 2,
        eligible_count: 1,
        sms_recipient_count: sms ? 1 : 0,
        email_recipient_count: email ? 1 : 0,
        dual_channel_count: sms && email ? 1 : 0,
        excluded_no_consent: 1,
        excluded_no_channel: 0,
        excluded_recent_contact: 0,
        estimated_cost_usd_cents: 0.79,
        candidate_limit: 500,
        may_have_more_candidates: false,
        audience_fingerprint: fingerprint,
        no_messages_sent: true,
      },
      p_recipients: [
        {
          client_profile_id: input.clientProfileId,
          sms,
          email,
        },
      ],
      p_now: now,
    } as never,
  );
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as {
    outcome: string;
    manifest_id: string | null;
    release_approval_id: string | null;
    audience_fingerprint: string | null;
    message_sha256: string | null;
  };
  return row;
}

export async function getCampaignReleaseState(jobId: string) {
  const [
    { data: job, error: jobError },
    { data: manifests, error: manifestError },
    { data: audits, error: auditError },
  ] =
    await Promise.all([
      supabase
        .from("ai_execution_jobs" as never)
        .select("status, result")
        .eq("id" as never, jobId)
        .single(),
      supabase
        .from("ai_campaign_manifests" as never)
        .select("*")
        .eq("source_execution_job_id" as never, jobId)
        .order("created_at" as never, { ascending: true }),
      supabase
        .from("ai_actions_log")
        .select("action_type, payload")
        .eq("agent", "execution_worker")
        .eq("action_type", "campaign_manifest_prepared")
        .eq("target_id", jobId)
        .order("created_at", { ascending: true }),
    ]);
  if (jobError) throw new Error(jobError.message);
  if (manifestError) throw new Error(manifestError.message);
  if (auditError) throw new Error(auditError.message);
  const manifestRows = (manifests ?? []) as Array<{
    id: string;
    salon_id: string;
    source_execution_job_id: string;
    source_approval_request_id: string;
    audience_fingerprint: string;
    message_sha256: string;
    message: string;
    summary: Record<string, unknown>;
  }>;
  const manifest = manifestRows.at(-1) ?? null;
  const [{ data: recipients, error: recipientError }, { data: approval, error: approvalError }] =
    manifest
      ? await Promise.all([
          supabase
            .from("ai_campaign_manifest_recipients" as never)
            .select("*")
            .eq("manifest_id" as never, manifest.id),
          supabase
            .from("approval_requests")
            .select("*")
            .eq("release_manifest_id", manifest.id)
            .single(),
        ])
      : [
          { data: [], error: null },
          { data: null, error: null },
        ];
  if (recipientError) throw new Error(recipientError.message);
  if (approvalError) throw new Error(approvalError.message);
  return {
    job: job as { status: string; result: Record<string, unknown> | null },
    manifests: manifestRows,
    manifest,
    recipients: (recipients ?? []) as Array<Record<string, unknown>>,
    releaseApproval: approval as
      | (Record<string, unknown> & {
          id: string;
          approve_token: string;
          status: string;
          payload: Record<string, unknown>;
        })
      | null,
    audits: (audits ?? []) as Array<{
      action_type: string;
      payload: Record<string, unknown>;
    }>,
  };
}

export async function recordTestCampaignDispatchPreflight(input: {
  salonId: string;
  jobId: string;
  manifestId: string;
  clientProfileId: string;
  exclusion?: "no_consent";
}) {
  const now = new Date().toISOString();
  const exclusion = input.exclusion ?? null;
  const sms = exclusion === null;
  const canonical =
    `${input.clientProfileId.toLowerCase()}:${sms ? "s" : ""}:` +
    (exclusion ?? "eligible");
  const fingerprint = createHash("sha256").update(canonical).digest("hex");
  const { data, error } = await supabase.rpc(
    "record_ai_campaign_dispatch_preflight" as never,
    {
      p_job_id: input.jobId,
      p_salon_id: input.salonId,
      p_summary: {
        preflight_at: now,
        manifest_id: input.manifestId,
        manifest_recipient_count: 1,
        eligible_count: exclusion === null ? 1 : 0,
        sms_recipient_count: sms ? 1 : 0,
        email_recipient_count: 0,
        dual_channel_count: 0,
        excluded_recent_contact: 0,
        excluded_no_consent: exclusion === "no_consent" ? 1 : 0,
        excluded_no_channel: 0,
        excluded_missing_profile: 0,
        excluded_manifest_channel_unavailable: 0,
        estimated_cost_usd_cents: sms ? 0.8 : 0,
        recipient_cap: 500,
        cost_cap_usd_cents: 500,
        preflight_fingerprint: fingerprint,
        dispatch_enabled: false,
        no_messages_sent: true,
      },
      p_decisions: [
        {
          client_profile_id: input.clientProfileId,
          sms,
          email: false,
          exclusion,
        },
      ],
      p_now: now,
    } as never,
  );
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data[0] : data) as {
    outcome: string;
    preflight_id: string | null;
    preflight_status: string | null;
    preflight_fingerprint: string | null;
  };
}

export async function getCampaignDispatchPreflightState(jobId: string) {
  const [
    { data: job, error: jobError },
    { data: preflights, error: preflightError },
    { data: audits, error: auditError },
  ] = await Promise.all([
    supabase
      .from("ai_execution_jobs" as never)
      .select("status, attempt_count, result")
      .eq("id" as never, jobId)
      .single(),
    supabase
      .from("ai_campaign_dispatch_preflights" as never)
      .select("*")
      .eq("release_execution_job_id" as never, jobId)
      .order("created_at" as never, { ascending: true }),
    supabase
      .from("ai_actions_log")
      .select("action_type, payload")
      .eq("agent", "execution_worker")
      .eq("action_type", "campaign_dispatch_preflight_recorded")
      .eq("target_id", jobId)
      .order("created_at", { ascending: true }),
  ]);
  if (jobError) throw new Error(jobError.message);
  if (preflightError) throw new Error(preflightError.message);
  if (auditError) throw new Error(auditError.message);
  return {
    job: job as {
      status: string;
      attempt_count: number;
      result: Record<string, unknown>;
    },
    preflights: (preflights ?? []) as Array<Record<string, unknown>>,
    audits: (audits ?? []) as Array<Record<string, unknown>>,
  };
}

export async function getApprovalEffectState(approvalId: string) {
  const [{ data: approval, error: approvalError }, { data: job, error: jobError }] =
    await Promise.all([
      supabase
        .from("approval_requests")
        .select("status, decided_at")
        .eq("id", approvalId)
        .single(),
      supabase
        .from("ai_execution_jobs" as never)
        .select("id, status, attempt_count, result, lease_token")
        .eq("approval_request_id" as never, approvalId)
        .maybeSingle(),
    ]);

  if (approvalError) throw new Error(approvalError.message);
  if (jobError) throw new Error(jobError.message);

  const executionJob = job as
    | {
        id: string;
        status: string;
        attempt_count: number;
        result: Record<string, unknown> | null;
        lease_token: string | null;
      }
    | null;

  const { data: effects, error: effectError } = executionJob
    ? await supabase
        .from("ai_actions_log")
        .select("action_type, target_id, payload")
        .eq("agent", "ai_execution")
        .eq("target_id", executionJob.id)
        .order("created_at", { ascending: true })
    : { data: [], error: null };

  if (effectError) throw new Error(effectError.message);

  return {
    approval: approval as { status: string; decided_at: string | null },
    job: executionJob,
    effects: (effects ?? []) as Array<{
      action_type: string;
      target_id: string | null;
      payload: Record<string, unknown> | null;
    }>,
  };
}

/**
 * Create a Supabase auth user for E2E tests that exercise email/password sign-in.
 * Uses the service-role admin API so no real email is sent.
 * Returns { userId, email, password }.
 */
export async function seedTestUser(opts?: { email?: string; password?: string }) {
  // Second instance of the hardcoded-credential bug, missed when
  // helpers/superadmin.ts was fixed: this default password sat in a PUBLIC repo
  // too, and this helper also mints real auth users. Same rule — a fresh random
  // password per run, held only in memory, never logged and never in an artifact.
  // Treat the old constant as permanently compromised.
  const email = opts?.email ?? `e2e-user-${randomUUID()}@nailiq.test.invalid`;
  const password = opts?.password ?? `E2E-${randomBytes(24).toString("base64url")}#Aa1`;

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
 * The new-customer name typed at the gate by `completeBookingEntryGate`. Exported
 * so specs can assert on the value the product pre-fills (e.g. the group flow
 * seeds member 0 with the organizer's gate name) without hardcoding the literal.
 */
export const GATE_NAME = "Test Guest";

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
 * Enter a national phone number only after the public booking gate is hydrated.
 *
 * The phone input is present in streamed SSR HTML before React's controlled
 * input handler is attached. On a fast repeat navigation, WebKit can therefore
 * accept a visible value without updating `entryPhoneRaw`; no customer lookup
 * runs and the gate waits forever. `booking-entry-hydrated` is client-only, so
 * observing it proves the handler is ready before the InputEvent is dispatched.
 */
export async function enterBookingPhone(
  page: Page,
  phone: string,
): Promise<void> {
  await page.getByTestId("booking-entry-hydrated").waitFor({
    state: "attached",
    timeout: 15_000,
  });
  const phoneInput = page.getByTestId("booking-entry-phone");
  await phoneInput.waitFor({ state: "visible", timeout: 15_000 });
  const digits = phone.replace(/\D/g, "");
  await setReactInputValue(phoneInput, digits.slice(-10));
}

/**
 * Clear the phone-first entry gate on an already-loaded public booking page.
 *
 * This is the single source of truth for "how a test gets through the gate",
 * shared by the individual flow (`gotoBookingServiceStep`), the group flow
 * (`gotoGroupFlow`), and any spec that seeds its own phone (e.g. the OTP suite).
 * When the product changes what the gate demands, this is the ONE place to
 * update — the reason 25 specs drifted was that each hand-rolled the gate.
 *
 * The gate opens (`flowReady` in BookingTypeSwitcher) only once ALL of these
 * hold — this helper satisfies them without weakening any of them:
 *  1. Phone — CountryPhoneField's inner input takes the 10-digit NATIONAL
 *     number (no country code). Passing the full E.164 (`+1604…`) makes the
 *     formatter slice it to a bogus area code and the gate never opens — the
 *     exact bug that sank the hand-rolled specs. We derive national = last 10.
 *  2. Name — a NEW customer must type ≥2 chars (a recognized profile skips this
 *     and `nameOk` is auto-true). The name input only appears after the ~400ms
 *     customer lookup, so we wait on IT, never on the consent checkbox (which
 *     renders on load and would resolve instantly, filling the name too early).
 *  3. SMS consent — required by Twilio A2P 10DLC / TCPA / CASL. Ticked here, at
 *     the gate, which is where the product now collects it. Never skipped.
 *
 * @param opts.phone  E.164 digits of the gate phone (default GATE_PHONE_DIGITS).
 * @param opts.name   New-customer name to type (default "Test Guest").
 * @param opts.keepProfile  Skip the new-customer reset (default: delete the
 *   profile first so the phone is treated as a new customer).
 */
export async function completeBookingEntryGate(
  page: Page,
  opts?: { phone?: string; name?: string; keepProfile?: boolean },
): Promise<void> {
  const digits = (opts?.phone ?? GATE_PHONE_DIGITS).replace(/\D/g, "");
  if (!opts?.keepProfile) {
    // A NEW customer keeps the name input visible (a recognized profile hides
    // it) and keeps Guest placeholders/name pre-fills at their defaults.
    await supabase.from("client_profiles").delete().eq("phone", digits);
  }
  // National number only — the last 10 digits, never the E.164 country code.
  await enterBookingPhone(page, digits);

  const nameInput = page.getByTestId("booking-entry-name");
  await nameInput.waitFor({ state: "visible", timeout: 8_000 });
  await nameInput.fill(opts?.name ?? GATE_NAME);
  await page.getByTestId("sms-consent").check();
}

/**
 * Complete the GATE OTP step for a `phone_otp_enabled` salon.
 *
 * The product moved OTP to the entry gate (commit `a4042c5` "gate-first OTP"):
 * once phone + name + SMS consent are satisfied, `GateOtpInline` renders inside
 * the phone card and the flow (service step / group toggle) stays locked until
 * the code is verified — `flowReady = gateReady && (!phoneOtpEnabled ||
 * gateOtpDone)`. This drives that widget; call it AFTER `completeBookingEntryGate`
 * (or the per-spec gate fill) and BEFORE waiting for the flow to unlock. On a
 * non-OTP salon there is no GateOtpInline, so do NOT call this there.
 *
 * Requires DEMO_OTP (magic code `000000`) — no real SMS is sent.
 */
export async function completeGateOtp(
  page: Page,
  opts?: { code?: string },
): Promise<void> {
  // idle stage → click "Send code" (fires /api/booking-otp/send).
  await page
    .getByTestId("booking-gate-otp-send")
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("booking-gate-otp-send").click();

  // sent stage → the code input appears; 6 digits auto-fires verifyCode()
  // (GateOtpInline.onCodeChange), so no explicit verify click is needed.
  const codeInput = page.getByTestId("booking-gate-otp-input");
  await codeInput.waitFor({ state: "visible", timeout: 15_000 });
  await setReactInputValue(codeInput, opts?.code ?? "000000");
}

/**
 * Navigate to a salon's public booking page and clear the phone-first entry
 * gate so the individual booking flow mounts and the service step renders.
 * Mirrors `gotoGroupFlow` for the non-group (individual) flow: the service
 * tiles only exist once the gate (phone + name + SMS consent) is cleared.
 */
export async function gotoBookingServiceStep(
  page: Page,
  slug: string,
): Promise<void> {
  await page.goto(`/${slug}`);
  await completeBookingEntryGate(page);
  await page
    .locator('[data-testid="service-tile-select"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
}
