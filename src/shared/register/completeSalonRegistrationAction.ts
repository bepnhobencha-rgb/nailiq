"use server";

import { cookies } from "next/headers";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  NAILQ_DEMO_SLUG_COOKIE,
  NAILQ_DEMO_SLUG_COOKIE_MAX_AGE_S,
  NAILQ_DEMO_SLUG_COOKIE_SECURE,
} from "@/shared/lib/demoDashboardCookie";
import { DEMO_SALON_SLUG, isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import { slugifySalonName } from "@/shared/lib/slugifySalonName";
import { DEFAULT_VERTICAL, resolveVertical } from "@/shared/verticals/registry";
import { getOrCreateDemoSalonOwnerUserId } from "@/shared/register/demoSalonOwner";
import { phoneDigitsFromAuthUser } from "@/shared/register/authUserPhone";
import { createTrialWindow } from "@/shared/lib/trial";
import {
  isRegisterPhoneDigitsValid,
  normalizeRegisterPhone,
} from "@/shared/register/phone";
import { pickAvailableSalonSlug } from "@/shared/register/salonSlugPicker";

export type CompleteSalonRegistrationResult =
  | { ok: true; slug: string; slugAdjusted: boolean }
  | {
      ok: false;
      error:
        | "invalid_name"
        | "invalid_completion_token"
        | "unauthorized"
        | "server_error"
        | "already_complete";
      /** Postgres or internal message when useful for debugging */
      message?: string;
    };

function registerCompletionDebugEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" ||
    process.env.DEBUG_REGISTER_FLOW === "1"
  );
}

/**
 * Conservative allowlist of timezones the wizard exposes. Defaults to
 * `America/Vancouver` per QA spec. Anything outside the allowlist is
 * rejected — prevents arbitrary IANA strings reaching the DB before
 * the production timezone-list contract is decided.
 */
const ALLOWED_WIZARD_TIMEZONES = [
  "America/Vancouver",
  "America/Toronto",
  "America/Edmonton",
  "America/Los_Angeles",
  "Asia/Ho_Chi_Minh",
] as const;

const DEFAULT_WIZARD_TIMEZONE = "America/Vancouver";
function normalizeWizardSlug(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeWizardTimezone(raw: string | null | undefined): string {
  const candidate = (raw ?? "").trim();
  if (!candidate) return DEFAULT_WIZARD_TIMEZONE;
  return (ALLOWED_WIZARD_TIMEZONES as readonly string[]).includes(candidate)
    ? candidate
    : DEFAULT_WIZARD_TIMEZONE;
}

export type CompleteSalonRegistrationInput = {
  /** Optional URL slug override. Empty/invalid → server picks from name. */
  slug?: string | null;
  /** Optional IANA timezone. Empty/invalid → America/Vancouver. */
  timezone?: string | null;
};

export async function completeSalonRegistration(
  salonNameRaw: string,
  completionTokenRaw?: string | null,
  extra?: CompleteSalonRegistrationInput,
): Promise<CompleteSalonRegistrationResult> {
  const name = salonNameRaw.trim();
  if (!name || name.length > 120) {
    return { ok: false, error: "invalid_name" };
  }

  const requestedSlug = normalizeWizardSlug(extra?.slug);
  const wizardTimezone = normalizeWizardTimezone(extra?.timezone);

  const isDemo = isDemoOtpRuntime();

  if (isDemo) {
    const token = completionTokenRaw?.trim();
    if (!token) {
      return { ok: false, error: "unauthorized" };
    }

    let admin;
    try {
      admin = createServiceRoleClient();
    } catch (e) {
      console.error("[completeSalonRegistration] demo admin client", e);
      return {
        ok: false,
        error: "server_error",
        message:
          e instanceof Error ? e.message : "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
      };
    }

    const { data: proof, error: proofErr } = await admin
      .from("register_completion_tokens")
      .select("id, phone, expires_at")
      .eq("token", token)
      .maybeSingle();

    if (proofErr || !proof?.phone) {
      console.error("[completeSalonRegistration] completion token lookup", proofErr);
      return { ok: false, error: "invalid_completion_token" };
    }

    const exp = new Date(String(proof.expires_at));
    if (exp.getTime() <= Date.now()) {
      await admin.from("register_completion_tokens").delete().eq("id", proof.id);
      return { ok: false, error: "invalid_completion_token" };
    }

    const phone = normalizeRegisterPhone(String(proof.phone));
    if (!isRegisterPhoneDigitsValid(phone)) {
      console.error("[completeSalonRegistration] demo invalid phone on token");
      return { ok: false, error: "invalid_completion_token" };
    }

    if (registerCompletionDebugEnabled()) {
      console.log("Inserting salon with phone:", phone);
    }

    const ownerUserId = await getOrCreateDemoSalonOwnerUserId();
    if (!ownerUserId) {
      return { ok: false, error: "server_error" };
    }

    // Demo mode shares a single salon at DEMO_SALON_SLUG across every
    // demo registration. If it already exists, skip the salon/services/
    // staff/salon_members inserts (they were created the first time)
    // and just consume the completion token + set the cookie.
    const { data: existingDemoSalon } = await admin
      .from("salons")
      .select("id, slug")
      .eq("slug", DEMO_SALON_SLUG)
      .maybeSingle();

    if (existingDemoSalon?.slug) {
      // Demo salon already exists — apply the wizard timestamp so the
      // dashboard gate doesn't re-redirect future demo signins.
      await admin
        .from("salons")
        .update({
          setup_wizard_completed_at: new Date().toISOString(),
        } as never)
        .eq("id", existingDemoSalon.id);

      await admin
        .from("register_completion_tokens")
        .delete()
        .eq("id", proof.id);

      const cookieStore = await cookies();
      cookieStore.set(NAILQ_DEMO_SLUG_COOKIE, String(existingDemoSalon.slug), {
        path: "/",
        maxAge: NAILQ_DEMO_SLUG_COOKIE_MAX_AGE_S,
        httpOnly: true,
        sameSite: "lax",
        secure: NAILQ_DEMO_SLUG_COOKIE_SECURE,
      });

      return {
        ok: true,
        slug: String(existingDemoSalon.slug),
        slugAdjusted: false,
      };
    }

    let slug: string;
    try {
      const slugSeed = requestedSlug || slugifySalonName(name);
      const picked = await pickAvailableSalonSlug(admin, slugSeed);
      slug = picked.slug;
    } catch (e) {
      console.error("[completeSalonRegistration] demo slug pick", e);
      return { ok: false, error: "server_error" };
    }

    // `setup_wizard_completed_at` is the gate the dashboard checks
    // before letting users in (see DashboardSlugLayout). Stamping it
    // here marks the wizard as complete in the same transaction that
    // creates the salon. Cast: column not yet in auto-generated types.
    const { data: salonRow, error: salonErr } = await admin
      .from("salons")
      .insert({
        slug,
        name,
        phone,
        timezone: wizardTimezone,
        setup_wizard_completed_at: new Date().toISOString(),
      } as never)
      .select("id, slug")
      .single();

    if (salonErr || !salonRow?.id || salonRow.slug == null) {
      console.error("[completeSalonRegistration] demo insert salon", salonErr);
      return {
        ok: false,
        error: "server_error",
        message: salonErr?.message,
      };
    }

    const salonId = salonRow.id as string;
    const actualSlug = String(salonRow.slug);
    const slugSeedForCompare = requestedSlug || slugifySalonName(name.trim());
    const resolvedSlugAdjusted = actualSlug !== slugSeedForCompare;

    const { error: svcErr } = await admin.from("services").insert({
      salon_id: salonId,
      name: "Gel Manicure",
      price_cents: 4500,
      duration_minutes: 45,
      buffer_minutes: 10,
    });

    if (svcErr) {
      console.error("[completeSalonRegistration] demo services", svcErr);
      await admin.from("salons").delete().eq("id", salonId);
      return {
        ok: false,
        error: "server_error",
        message: svcErr.message,
      };
    }

    const { error: staffErr } = await admin.from("staff").insert({
      salon_id: salonId,
      name: "Staff 1",
      job_role: "owner",
    });

    if (staffErr) {
      console.error("[completeSalonRegistration] demo staff", staffErr);
      await admin.from("services").delete().eq("salon_id", salonId);
      await admin.from("salons").delete().eq("id", salonId);
      return {
        ok: false,
        error: "server_error",
        message: staffErr.message,
      };
    }

    const { error: memErr } = await admin.from("salon_members").insert({
      salon_id: salonId,
      user_id: ownerUserId,
      role: "owner",
    });

    if (memErr) {
      console.error("[completeSalonRegistration] demo salon_members", memErr);
      await admin.from("staff").delete().eq("salon_id", salonId);
      await admin.from("services").delete().eq("salon_id", salonId);
      await admin.from("salons").delete().eq("id", salonId);
      return {
        ok: false,
        error: "server_error",
        message: memErr.message,
      };
    }

    await admin.from("register_completion_tokens").delete().eq("id", proof.id);

    const cookieStore = await cookies();
    cookieStore.set(NAILQ_DEMO_SLUG_COOKIE, actualSlug, {
      path: "/",
      maxAge: NAILQ_DEMO_SLUG_COOKIE_MAX_AGE_S,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });

    return { ok: true, slug: actualSlug, slugAdjusted: resolvedSlugAdjusted };
  }

  let supabase;
  try {
    supabase = await createClient();
  } catch (e) {
    console.error("FAILED step 1", e);
    return { ok: false, error: "unauthorized" };
  }

  const {
    data: { user },
    error: getUserErr,
  } = await supabase.auth.getUser();

  if (getUserErr) {
    console.error("FAILED step 1", getUserErr);
    return { ok: false, error: "unauthorized" };
  }

  if (!user) {
    console.error("FAILED step 1", new Error("no user"));
    return { ok: false, error: "unauthorized" };
  }

  if (registerCompletionDebugEnabled()) {
    console.log("Step 1: getUser", { userId: user.id });
  }

  const { data: existingMember } = await supabase
    .from("salon_members")
    .select("salon_id")
    .eq("user_id", user.id)
    .maybeSingle();

  // Existing-member rename branch. The user is already linked to a
  // salon — apply the wizard inputs as an UPDATE rather than creating
  // a second row. Closes the loop on the wizard gate: a salon with
  // setup_wizard_completed_at IS NULL gets stamped here so the
  // dashboard stops redirecting back.
  if (existingMember?.salon_id) {
    let renameAdmin;
    try {
      renameAdmin = createServiceRoleClient();
    } catch (e) {
      console.error("[completeSalonRegistration] rename admin client", e);
      return { ok: false, error: "server_error" };
    }

    const { data: existingSalon, error: existErr } = await renameAdmin
      .from("salons")
      .select("id, slug, name")
      .eq("id", existingMember.salon_id)
      .maybeSingle();

    if (existErr || !existingSalon?.id) {
      console.error(
        "[completeSalonRegistration] rename existing salon lookup",
        existErr,
      );
      return { ok: false, error: "server_error" };
    }

    const currentSlug = String(existingSalon.slug ?? "").trim();
    const targetSlug = requestedSlug || slugifySalonName(name);

    let nextSlug = currentSlug;
    if (targetSlug && targetSlug !== currentSlug) {
      try {
        const picked = await pickAvailableSalonSlug(renameAdmin, targetSlug);
        nextSlug = picked.slug;
      } catch (e) {
        console.error("[completeSalonRegistration] rename slug pick", e);
        return { ok: false, error: "server_error" };
      }
    }

    const { error: upErr } = await renameAdmin
      .from("salons")
      .update({
        name,
        slug: nextSlug,
        timezone: wizardTimezone,
        setup_wizard_completed_at: new Date().toISOString(),
      } as never)
      .eq("id", existingSalon.id);

    if (upErr) {
      console.error("[completeSalonRegistration] rename update", upErr);
      return {
        ok: false,
        error: "server_error",
        message: upErr.message,
      };
    }

    return {
      ok: true,
      slug: nextSlug,
      slugAdjusted: nextSlug !== targetSlug,
    };
  }

  const completionTok = completionTokenRaw?.trim();

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("FAILED before step 2 (service role client)", e);
    return {
      ok: false,
      error: "server_error",
      message:
        e instanceof Error ? e.message : "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    };
  }

  // OAuth / email magic-link signups land here authenticated but without
  // an SMS-verified completion token. We allow them through and create
  // the salon with a blank phone — the owner can fill it in later from
  // /dashboard/[slug]/settings. Phone-OTP signups continue to enforce
  // the original token + phone-match contract below.
  let phoneForSalon = "";
  let proofIdToDelete: string | null = null;

  if (completionTok) {
    const { data: proof, error: proofErr } = await admin
      .from("register_completion_tokens")
      .select("id, phone, expires_at")
      .eq("token", completionTok)
      .maybeSingle();

    if (proofErr || !proof?.phone) {
      console.error("[completeSalonRegistration] completion token lookup", proofErr);
      return { ok: false, error: "invalid_completion_token" };
    }

    const proofExp = new Date(String(proof.expires_at));
    if (proofExp.getTime() <= Date.now()) {
      await admin.from("register_completion_tokens").delete().eq("id", proof.id);
      return { ok: false, error: "invalid_completion_token" };
    }

    const authDigits = phoneDigitsFromAuthUser(user);
    const proofDigits = normalizeRegisterPhone(String(proof.phone));
    const authNorm = normalizeRegisterPhone(authDigits);
    if (!proofDigits || !authNorm || proofDigits !== authNorm) {
      return { ok: false, error: "invalid_completion_token" };
    }

    phoneForSalon = proofDigits;
    proofIdToDelete = String(proof.id);
  }

  if (registerCompletionDebugEnabled()) {
    console.log("Inserting salon with phone:", phoneForSalon || "(blank)");
  }

  let slug: string;
  try {
    const slugSeed = requestedSlug || slugifySalonName(name);
    const picked = await pickAvailableSalonSlug(admin, slugSeed);
    slug = picked.slug;
  } catch (e) {
    console.error("FAILED before step 2 (slug pick)", e);
    return { ok: false, error: "server_error" };
  }

  if (registerCompletionDebugEnabled()) {
    console.log("Step 2: insert salon", {
      slug,
      name,
      phone: phoneForSalon,
      timezone: wizardTimezone,
    });
  }

  const trial = createTrialWindow();
  const { data: salonRow, error: salonErr } = await admin
    .from("salons")
    .insert({
      slug,
      name,
      phone: phoneForSalon,
      timezone: wizardTimezone,
      setup_wizard_completed_at: new Date().toISOString(),
      // New salons start with all reminder channels on.
      reminders_enabled: true,
      reminder_24h_enabled: true,
      reminder_3h_enabled: true,
      sms_reminders_enabled: true,
      subscription_plan: "free",
      subscription_status: "trialing",
      trial_started_at: trial.trialStartedAt,
      trial_ends_at: trial.trialEndsAt,
    } as never)
    .select("id, slug")
    .single();

  if (salonErr || !salonRow?.id || salonRow.slug == null) {
    console.error("FAILED step 2", salonErr ?? new Error("no salon id"));
    return {
      ok: false,
      error: "server_error",
      message: salonErr?.message,
    };
  }

  const salonId = salonRow.id as string;
  const actualSlug = String(salonRow.slug);
  const resolvedSlugAdjusted = actualSlug !== slugifySalonName(name.trim());

  if (registerCompletionDebugEnabled()) {
    console.log("Step 3: insert default services");
  }

  // Seed catalogue comes from the vertical registry. New registrations default
  // to the nail-salon vertical; other verticals are assigned in Admin Settings
  // after onboarding (then services can be re-seeded / edited there).
  const DEFAULT_SERVICES = resolveVertical(DEFAULT_VERTICAL).seedServices.map(
    (svc) => ({ ...svc, salon_id: salonId }),
  );

  const { error: svcErr } = await admin.from("services").insert(DEFAULT_SERVICES as never);

  if (svcErr) {
    console.error("FAILED step 3", svcErr);
    await admin.from("salons").delete().eq("id", salonId);
    return {
      ok: false,
      error: "server_error",
      message: svcErr.message,
    };
  }

  if (registerCompletionDebugEnabled()) {
    console.log("Step 4: insert staff");
  }

  const { error: staffErr } = await admin.from("staff").insert({
    salon_id: salonId,
    name: "Staff 1",
    job_role: "owner",
  });

  if (staffErr) {
    console.error("FAILED step 4", staffErr);
    await admin.from("services").delete().eq("salon_id", salonId);
    await admin.from("salons").delete().eq("id", salonId);
    return {
      ok: false,
      error: "server_error",
      message: staffErr.message,
    };
  }

  if (registerCompletionDebugEnabled()) {
    console.log("Step 5: insert salon_members", {
      salon_id: salonId,
      user_id: user.id,
    });
  }

  const { error: memErr } = await admin.from("salon_members").insert({
    salon_id: salonId,
    user_id: user.id,
    role: "owner",
  });

  if (memErr) {
    console.error("FAILED step 5", memErr);
    await admin.from("staff").delete().eq("salon_id", salonId);
    await admin.from("services").delete().eq("salon_id", salonId);
    await admin.from("salons").delete().eq("id", salonId);
    return {
      ok: false,
      error: "server_error",
      message: memErr.message,
    };
  }

  if (proofIdToDelete) {
    await admin
      .from("register_completion_tokens")
      .delete()
      .eq("id", proofIdToDelete);
  }

  return {
    ok: true,
    slug: actualSlug,
    slugAdjusted: resolvedSlugAdjusted,
  };
}
