import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { GoLiveReadinessPageContent } from "@/components/dashboard/GoLiveReadinessPanel";
import { GuidedSetupReturnCard } from "@/components/dashboard/GuidedSetupReturnCard";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { loadGoLiveReadiness } from "@/shared/dashboard/loadGoLiveReadiness";

type Props = { params: Promise<{ slug: string }> };

export const metadata: Metadata = {
  title: "Go-Live Readiness · NailIQ",
  description: "Check a salon's operational readiness before go-live.",
};

export default async function GoLiveReadinessPage({ params }: Props) {
  const { slug } = await params;
  const result = await loadGoLiveReadiness(slug);

  if (!result.ok && result.reason === "unauthorized") {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:pt-6">
        {result.ok && result.guidedSetupEnabled ? (
          <GuidedSetupReturnCard slug={slug} currentStep="go-live" />
        ) : null}
        <GoLiveReadinessPageContent
          slug={slug}
          readiness={result.ok ? result.readiness : null}
          salonName={result.ok ? result.salonName : null}
          role={result.ok ? result.role : null}
          attestationState={result.ok ? result.attestationState : null}
          attestationEvents={result.ok ? result.attestationEvents : []}
        />
      </MobileStack>
    </ResponsiveShell>
  );
}
