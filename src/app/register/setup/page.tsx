import { notFound, redirect } from "next/navigation";
import {
  dashboardPathForRole,
  normalizeSalonMemberRole,
} from "@/shared/lib/salonMemberRole";
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
    // Resolve the sole membership's canonical salon before choosing its
    // role-aware destination. Owners may continue into the rename wizard;
    // every other role is redirected before that form can render.
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
      console.error("[RegisterSetupPage] member salon", salonRowRes.error);
      notFound();
    }

    // Password auth intentionally performs a full navigation through this
    // page so the freshly-written session cookie reaches the server. Setup
    // itself remains Owner-only: every sole non-owner membership is routed to
    // its normal dashboard before the setup form can render. If the Owner has
    // not completed setup yet, fail closed instead of creating a redirect loop
    // with the dashboard's unfinished-wizard gate.
    const role = normalizeSalonMemberRole(member.role);
    if (role !== "owner") {
      if (salonRow?.setup_wizard_completed_at == null) {
        notFound();
      }
      redirect(dashboardPathForRole(slug, role));
    }

    // The owner wizard handles renames for half-completed salons
    // (setup_wizard_completed_at IS NULL). The dashboard layout's gate will
    // redirect back here while the timestamp is null, so only short-circuit
    // when the wizard has already been completed.
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
