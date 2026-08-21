import { notFound, redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import { shouldUseAnonymousDemoRegistration } from "@/shared/register/registrationRuntimeMode";
import RegisterSetupInner, {
  type RegisterSetupInitial,
} from "./RegisterSetupInner";

export const dynamic = "force-dynamic";

export default async function RegisterSetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const useAnonymousDemoFlow = shouldUseAnonymousDemoRegistration(
    isDemoOtpRuntime(),
    Boolean(user),
  );
  if (useAnonymousDemoFlow) {
    return <RegisterSetupInner isDemoMode />;
  }

  if (!user) {
    redirect("/register");
  }

  const { data: membershipRows, error: memberErr } = await supabase
    .from("salon_members")
    .select("salon_id, role")
    .eq("user_id", user.id);

  if (memberErr) {
    console.error("[RegisterSetupPage] salon_members", memberErr);
    notFound();
  }

  const memberships = (membershipRows ?? []).filter((membership) =>
    Boolean(membership?.salon_id),
  );

  // This route has no salon selector. A multi-salon account must make an
  // explicit choice and can never fall through to the fresh-salon form.
  if (memberships.length > 1) {
    redirect("/choose-salon");
  }

  let initial: RegisterSetupInitial | null = null;
  const member = memberships[0];

  if (member?.salon_id) {
    // Registration setup can rename/complete only the canonical owner row.
    // Admin and staff memberships use their normal dashboard destinations.
    if (member.role !== "owner") {
      notFound();
    }

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

    if (salonRowRes.error || !slug) {
      console.error("[RegisterSetupPage] owner salon", salonRowRes.error);
      notFound();
    }

    if (salonRow?.setup_wizard_completed_at != null) {
      // Wizard already done — go straight to dashboard.
      redirect(`/dashboard/${encodeURIComponent(slug)}`);
    }

    // Wizard NOT done — prefill the form with the existing salon's current
    // values so the owner can correct rather than re-type.
    initial = {
      mode: "rename",
      currentSlug: slug,
      name: (salonRow?.name ?? "").trim(),
      timezone: (salonRow?.timezone ?? "").trim() || null,
    };
  }

  return <RegisterSetupInner isDemoMode={false} initial={initial} />;
}
