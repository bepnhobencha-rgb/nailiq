import { redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import RegisterSetupInner, {
  type RegisterSetupInitial,
} from "./RegisterSetupInner";

export const dynamic = "force-dynamic";

export default async function RegisterSetupPage() {
  const demo = isDemoOtpRuntime();

  if (demo) {
    return <RegisterSetupInner isDemoMode={demo} />;
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

  let initial: RegisterSetupInitial | null = null;

  if (member?.salon_id) {
    // The user already owns a salon. We used to bounce them to the
    // dashboard here — but the wizard now also handles renames for
    // half-completed salons (setup_wizard_completed_at IS NULL). The
    // dashboard layout's gate will redirect back here while the
    // timestamp is null, so honour that contract: only short-circuit
    // when the wizard has already been completed.
    // Cast: column not yet in auto-generated DB types.
    const salonRowRes = (await supabase
      .from("salons")
      .select(
        "slug, name, timezone, setup_wizard_completed_at" as never,
      )
      .eq("id", member.salon_id)
      .maybeSingle()) as {
      data: {
        slug?: string | null;
        name?: string | null;
        timezone?: string | null;
        setup_wizard_completed_at?: string | null;
      } | null;
      error: unknown;
    };

    const salonRow = salonRowRes.data;
    const slug = salonRow?.slug?.trim();

    if (slug && salonRow?.setup_wizard_completed_at != null) {
      // Wizard already done — go straight to dashboard.
      redirect(`/dashboard/${encodeURIComponent(slug)}`);
    }

    if (slug) {
      // Wizard NOT done — prefill the form with the existing salon's
      // current values so the user can correct rather than re-type.
      initial = {
        mode: "rename",
        currentSlug: slug,
        name: (salonRow?.name ?? "").trim(),
        timezone: (salonRow?.timezone ?? "").trim() || null,
      };
    }
  }

  return <RegisterSetupInner isDemoMode={demo} initial={initial} />;
}
