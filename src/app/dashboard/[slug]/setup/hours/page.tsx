import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { GuidedSetupReturnCard } from "@/components/dashboard/GuidedSetupReturnCard";
import { HoursSetupPanel } from "@/components/dashboard/HoursSetupPanel";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Setup · Hours · ${slug}`,
    description: "Set salon opening hours.",
  };
}

export default async function SetupHoursPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }
  // Salon config is management-only (owner/admin).
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  const rawHours = ctx.salon.opening_hours;
  const guidedSetupEnabled = isReleaseFeatureEnabled(
    ctx.salon,
    "guided_admin_setup",
  );

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 sm:pt-6">
        <SetupBackNav
          slug={slug}
          title="Giờ mở cửa · Opening hours"
          backHref={
            guidedSetupEnabled
              ? `/dashboard/${encodeURIComponent(slug)}/setup`
              : undefined
          }
          backLabel={guidedSetupEnabled ? "← Setup" : undefined}
        />
        <HoursSetupPanel
          slug={slug}
          initialRaw={rawHours}
          initialClosedDatesRaw={ctx.salon.booking_closed_dates}
          autoSave={guidedSetupEnabled}
        />
        {guidedSetupEnabled ? <GuidedSetupReturnCard slug={slug} /> : null}
      </MobileStack>
    </ResponsiveShell>
  );
}
