import { redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import RegisterSetupInner from "./RegisterSetupInner";

export const dynamic = "force-dynamic";

export default async function RegisterSetupPage() {
  const demo = isDemoOtpRuntime();

  if (demo) {
    return <RegisterSetupInner />;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/register");
  }

  const { data: member, error: memberErr } = await supabase
    .from("salon_members")
    .select("salon_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (memberErr) {
    console.error("[RegisterSetupPage] salon_members", memberErr);
  }

  if (member?.salon_id) {
    const { data: salon, error: salonErr } = await supabase
      .from("salons")
      .select("slug")
      .eq("id", member.salon_id)
      .maybeSingle();

    if (salonErr) {
      console.error("[RegisterSetupPage] salons by id", salonErr);
    }

    const slug = salon?.slug?.trim();
    if (slug) {
      redirect(`/dashboard/${encodeURIComponent(slug)}`);
    }
  }

  return <RegisterSetupInner />;
}
