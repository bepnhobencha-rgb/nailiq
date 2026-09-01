import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SalonOwnerDashboard } from "@/components/dashboard/SalonOwnerDashboard";
import { GuidedAdminActionCenter } from "@/components/dashboard/GuidedAdminActionCenter";
import {
  loadSalonOwnerDashboard,
  resolveSalonForDashboard,
} from "@/shared/dashboard/salonOwnerActions";
import { loadOwnerHomeDashboard } from "@/shared/dashboard/loadOwnerHomeDashboardAction";
import { loadGoLiveReadiness } from "@/shared/dashboard/loadGoLiveReadiness";
import {
  deriveGuidedSetupProgress,
  resolveGuidedDashboardRoot,
} from "@/shared/dashboard/guidedSetup";
import { isCocoSetupExperienceVisible } from "@/shared/dashboard/cocoSetupActivation";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  // Reuse the exact request-scoped membership projection consumed by the
  // page. This removes a separate salon query while keeping tenant metadata
  // unavailable to unauthenticated callers.
  const resolved = await resolveSalonForDashboard(slug);
  const name = resolved?.salon.name?.trim();
  const title = name ? `${name} · Dashboard` : "Salon dashboard";
  return {
    title,
    description: "Today's bookings, revenue snapshot, and upcoming appointments.",
  };
}

export default async function SalonDashboardPage({ params }: Props) {
  const { slug } = await params;

  // Fetch both in parallel — home analytics doesn't block the main dashboard
  const [initialResult, homeResult] = await Promise.all([
    loadSalonOwnerDashboard(slug),
    loadOwnerHomeDashboard(slug),
  ]);

  // Do not redirect an authorization miss to /register. The request proxy
  // redirects authenticated salon members from /register back to this route,
  // so a stale session or a temporarily unavailable membership projection can
  // otherwise create a dashboard -> register -> dashboard loop. Rendering the
  // dashboard's fail-closed retry state keeps salon data hidden and gives the
  // browser a stable document instead of an endless navigation skeleton.

  let guidedSetupComplete: boolean | null = null;
  let guidedSetupEnabled = false;
  if (
    initialResult.ok &&
    !initialResult.demoMode &&
    (await isCocoSetupExperienceVisible(initialResult.salon))
  ) {
    guidedSetupEnabled = true;
    const setupResult = await loadGoLiveReadiness(slug);
    guidedSetupComplete = setupResult.ok
      ? deriveGuidedSetupProgress(slug, setupResult.readiness).complete
      : null;
  }

  const guidedRoot = resolveGuidedDashboardRoot(
    guidedSetupEnabled,
    guidedSetupComplete,
  );
  if (guidedRoot === "setup") {
    redirect(`/dashboard/${encodeURIComponent(slug)}/setup`);
  }

  if (guidedRoot === "action-center" && initialResult.ok) {
    return (
      <GuidedAdminActionCenter
        slug={slug}
        salonName={(initialResult.salon.name ?? "").trim() || slug}
      />
    );
  }

  return (
    <SalonOwnerDashboard
      slug={slug}
      initialResult={initialResult}
      homeData={homeResult.ok ? homeResult.data : null}
    />
  );
}
