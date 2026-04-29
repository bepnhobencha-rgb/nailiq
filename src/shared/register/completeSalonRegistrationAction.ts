"use server";

import { cookies } from "next/headers";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  NAILQ_DEMO_SLUG_COOKIE,
  NAILQ_DEMO_SLUG_COOKIE_MAX_AGE_S,
} from "@/shared/lib/demoDashboardCookie";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import { slugifySalonName } from "@/shared/lib/slugifySalonName";
import { getOrCreateDemoSalonOwnerUserId } from "@/shared/register/demoSalonOwner";
import { phoneDigitsFromAuthUser } from "@/shared/register/authUserPhone";
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

export async function completeSalonRegistration(
  salonNameRaw: string,
  completionTokenRaw?: string | null,
): Promise<CompleteSalonRegistrationResult> {
  const name = salonNameRaw.trim();
  if (!name || name.length > 120) {
    return { ok: false, error: "invalid_name" };
  }

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

    let slug: string;
    try {
      const picked = await pickAvailableSalonSlug(
        admin,
        slugifySalonName(name),
      );
      slug = picked.slug;
    } catch (e) {
      console.error("[completeSalonRegistration] demo slug pick", e);
      return { ok: false, error: "server_error" };
    }

    const { data: salonRow, error: salonErr } = await admin
      .from("salons")
      .insert({
        slug,
        name,
        phone,
      })
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
    const resolvedSlugAdjusted = actualSlug !== slugifySalonName(name.trim());

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

  console.log("Step 1: getUser", { userId: user.id });

  const { data: existingMember } = await supabase
    .from("salon_members")
    .select("salon_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existingMember?.salon_id) {
    const { data: salonRow } = await supabase
      .from("salons")
      .select("slug")
      .eq("id", existingMember.salon_id)
      .maybeSingle();
    if (salonRow?.slug) {
      return {
        ok: true,
        slug: String(salonRow.slug),
        slugAdjusted: false,
      };
    }
  }

  const completionTok = completionTokenRaw?.trim();
  if (!completionTok) {
    return { ok: false, error: "invalid_completion_token" };
  }

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

  if (registerCompletionDebugEnabled()) {
    console.log("Inserting salon with phone:", proofDigits);
  }

  let slug: string;
  try {
    const picked = await pickAvailableSalonSlug(
      admin,
      slugifySalonName(name),
    );
    slug = picked.slug;
  } catch (e) {
    console.error("FAILED before step 2 (slug pick)", e);
    return { ok: false, error: "server_error" };
  }

  console.log("Step 2: insert salon", { slug, name, phone: proofDigits });

  const { data: salonRow, error: salonErr } = await admin
    .from("salons")
    .insert({
      slug,
      name,
      phone: proofDigits,
    })
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

  console.log("Step 3: insert services");

  const { error: svcErr } = await admin.from("services").insert({
    salon_id: salonId,
    name: "Gel Manicure",
    price_cents: 4500,
    duration_minutes: 45,
    buffer_minutes: 10,
  });

  if (svcErr) {
    console.error("FAILED step 3", svcErr);
    await admin.from("salons").delete().eq("id", salonId);
    return {
      ok: false,
      error: "server_error",
      message: svcErr.message,
    };
  }

  console.log("Step 4: insert staff");

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

  console.log("Step 5: insert salon_members", {
    salon_id: salonId,
    user_id: user.id,
  });

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

  await admin.from("register_completion_tokens").delete().eq("id", proof.id);

  return {
    ok: true,
    slug: actualSlug,
    slugAdjusted: resolvedSlugAdjusted,
  };
}
