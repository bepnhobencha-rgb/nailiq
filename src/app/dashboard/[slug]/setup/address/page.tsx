import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { GuidedSetupReturnCard } from "@/components/dashboard/GuidedSetupReturnCard";
import { AddressSetupPanel } from "@/components/dashboard/AddressSetupPanel";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import { parseCurrency } from "@/shared/lib/currencyFormat";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Setup · Address · ${slug}`,
    description: "Add your salon address and public phone.",
  };
}

export default async function SetupAddressPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }
  // Salon config is management-only (owner/admin).
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  // currency_code lives on the salon row but isn't exposed by
  // `getDashboardWriteClient` yet, so query it directly here. Column
  // was added by migration 20260512000000; cast for the select since
  // the auto-generated DB types haven't been refreshed.
  // P2.8 — also pull `description` (column added by migration
  // 20260512100000). Same `as never` pattern as currency_code.
  // Task #04-B — `timezone` is now NOT NULL (migration
  // 20260512600000_timezone_required). Pulled so the address
  // panel's timezone dropdown can pre-select the salon's current
  // value rather than forcing the owner to re-pick on every visit.
  const { data: extraRow } = await ctx.supabase
    .from("salons")
    .select("currency_code, description, timezone" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const extraData = (extraRow ?? null) as {
    currency_code?: unknown;
    description?: unknown;
    timezone?: unknown;
  } | null;
  const initialCurrency = parseCurrency(extraData?.currency_code);
  const initialDescription =
    typeof extraData?.description === "string" ? extraData.description : "";
  const initialTimezone =
    typeof extraData?.timezone === "string" &&
    extraData.timezone.trim().length > 0
      ? extraData.timezone
      : "";
  const guidedSetupEnabled = await isReleaseFeatureVisible(
    ctx.salon,
    "guided_admin_setup",
  );

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 sm:pt-6">
        <SetupBackNav
          slug={slug}
          title="Địa chỉ tiệm · Salon address"
          backHref={
            guidedSetupEnabled
              ? `/dashboard/${encodeURIComponent(slug)}/setup`
              : undefined
          }
          backLabel={guidedSetupEnabled ? "← Setup" : undefined}
        />
        <AddressSetupPanel
          slug={slug}
          initialSalonName={ctx.salon.name ?? ""}
          showSalonName={guidedSetupEnabled}
          initialAddress={ctx.salon.address ?? ""}
          initialSalonPhone={ctx.salon.salon_phone ?? ""}
          initialCurrency={initialCurrency}
          initialDescription={initialDescription}
          initialTimezone={initialTimezone}
          autoSave={guidedSetupEnabled}
        />
        {guidedSetupEnabled ? (
          <GuidedSetupReturnCard slug={slug} currentStep="salon-profile" />
        ) : null}
      </MobileStack>
    </ResponsiveShell>
  );
}
