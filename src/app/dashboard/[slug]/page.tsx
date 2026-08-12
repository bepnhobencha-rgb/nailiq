import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SalonOwnerDashboard } from "@/components/dashboard/SalonOwnerDashboard";
import { createClient } from "@/shared/lib/supabase/server";
import { loadSalonOwnerDashboard } from "@/shared/dashboard/salonOwnerActions";
import { loadOwnerHomeDashboard } from "@/shared/dashboard/loadOwnerHomeDashboardAction";
import { loadGoLiveReadiness } from "@/shared/dashboard/loadGoLiveReadiness";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("salons")
    .select("name")
    .eq("slug", slug)
    .maybeSingle();

  const name = data?.name?.trim();
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

  if (!initialResult.ok && initialResult.error === "unauthorized") {
    redirect("/register");
  }

  if (
    initialResult.ok &&
    !initialResult.demoMode &&
    isReleaseFeatureEnabled(initialResult.salon, "guided_admin_setup")
  ) {
    const setupResult = await loadGoLiveReadiness(slug);
    if (setupResult.ok && !setupResult.readiness.approvedForGoLive) {
      redirect(`/dashboard/${encodeURIComponent(slug)}/setup`);
    }
  }

  return (
    <SalonOwnerDashboard
      slug={slug}
      initialResult={initialResult}
      homeData={homeResult.ok ? homeResult.data : null}
    />
  );
}
