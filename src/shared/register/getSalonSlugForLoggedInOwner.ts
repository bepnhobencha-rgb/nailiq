"use server";

import { createClient } from "@/shared/lib/supabase/server";

/**
 * After phone OTP verification, the browser has a Supabase session.
 * Returning owners already have a salon_members row — send them to `/dashboard/[slug]`.
 */
export async function getSalonSlugForLoggedInOwner(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: member, error: memberErr } = await supabase
    .from("salon_members")
    .select("salon_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (memberErr) {
    console.error("[getSalonSlugForLoggedInOwner] salon_members", memberErr);
    return null;
  }
  if (!member?.salon_id) return null;

  const { data: salon, error: salonErr } = await supabase
    .from("salons")
    .select("slug")
    .eq("id", member.salon_id)
    .maybeSingle();

  if (salonErr) {
    console.error("[getSalonSlugForLoggedInOwner] salons", salonErr);
    return null;
  }

  const slug = salon?.slug?.trim();
  return slug ? String(slug) : null;
}
