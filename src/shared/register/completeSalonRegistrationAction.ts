"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { slugifySalonName } from "@/shared/lib/slugifySalonName";
import { phoneDigitsFromAuthUser } from "@/shared/register/authUserPhone";
import { pickAvailableSalonSlug } from "@/shared/register/salonSlugPicker";

export type CompleteSalonRegistrationResult =
  | { ok: true; slug: string; slugAdjusted: boolean }
  | {
      ok: false;
      error:
        | "invalid_name"
        | "unauthorized"
        | "server_error"
        | "already_complete";
    };

export async function completeSalonRegistration(
  salonNameRaw: string,
): Promise<CompleteSalonRegistrationResult> {
  const name = salonNameRaw.trim();
  if (!name || name.length > 120) {
    return { ok: false, error: "invalid_name" };
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

  const phone = phoneDigitsFromAuthUser(user);

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch (e) {
    console.error("FAILED before step 2 (service role client)", e);
    return { ok: false, error: "server_error" };
  }

  let slug: string;
  let slugAdjusted: boolean;
  try {
    const picked = await pickAvailableSalonSlug(
      admin,
      slugifySalonName(name),
    );
    slug = picked.slug;
    slugAdjusted = picked.slugAdjusted;
  } catch (e) {
    console.error("FAILED before step 2 (slug pick)", e);
    return { ok: false, error: "server_error" };
  }

  console.log("Step 2: insert salon", { slug, name, phone });

  const { data: salonRow, error: salonErr } = await admin
    .from("salons")
    .insert({
      slug,
      name,
      phone: phone || "",
    })
    .select("id")
    .single();

  if (salonErr || !salonRow?.id) {
    console.error("FAILED step 2", salonErr ?? new Error("no salon id"));
    return { ok: false, error: "server_error" };
  }

  const salonId = salonRow.id as string;

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
    return { ok: false, error: "server_error" };
  }

  console.log("Step 4: insert staff");

  const { error: staffErr } = await admin.from("staff").insert({
    salon_id: salonId,
    name: "Staff 1",
  });

  if (staffErr) {
    console.error("FAILED step 4", staffErr);
    await admin.from("services").delete().eq("salon_id", salonId);
    await admin.from("salons").delete().eq("id", salonId);
    return { ok: false, error: "server_error" };
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
    return { ok: false, error: "server_error" };
  }

  return { ok: true, slug, slugAdjusted };
}
