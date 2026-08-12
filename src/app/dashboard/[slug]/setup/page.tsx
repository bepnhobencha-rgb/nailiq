import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { GuidedSetupHub } from "@/components/dashboard/GuidedSetupHub";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { loadGoLiveReadiness } from "@/shared/dashboard/loadGoLiveReadiness";

type Props = { params: Promise<{ slug: string }> };

export const metadata: Metadata = {
  title: "Setup · NailIQ",
  description: "Finish setting up your salon one step at a time.",
};

export default async function SetupIndexPage({ params }: Props) {
  const { slug } = await params;
  const result = await loadGoLiveReadiness(slug);

  if (!result.ok && result.reason === "unauthorized") {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  if (result.ok && !result.guidedSetupEnabled) {
    redirect(`/dashboard/${encodeURIComponent(slug)}/setup/services`);
  }

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6">
        {result.ok ? (
          <GuidedSetupHub
            slug={slug}
            salonName={result.salonName}
            readiness={result.readiness}
          />
        ) : (
          <section
            role="alert"
            className="rounded-2xl border border-nq-danger/40 bg-nq-danger/10 p-4 text-base leading-6 text-nq-foreground"
          >
            NailIQ could not read the setup progress. Please try again.
          </section>
        )}
      </MobileStack>
    </ResponsiveShell>
  );
}
