import { redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import RegisterSetupInner from "./RegisterSetupInner";

export default async function RegisterSetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/register");
  }

  const { data: member } = await supabase
    .from("salon_members")
    .select("salon_id, salons!inner(slug)")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  const slug =
    member &&
    member.salons &&
    typeof member.salons === "object" &&
    "slug" in member.salons
      ? String((member.salons as { slug: string }).slug)
      : "";

  if (slug) {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  return <RegisterSetupInner />;
}
