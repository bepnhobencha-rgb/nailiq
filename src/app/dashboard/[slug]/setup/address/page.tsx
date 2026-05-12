import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { AddressSetupPanel } from "@/components/dashboard/AddressSetupPanel";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
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

  // currency_code lives on the salon row but isn't exposed by
  // `getDashboardWriteClient` yet, so query it directly here. Column
  // was added by migration 20260512000000; cast for the select since
  // the auto-generated DB types haven't been refreshed.
  // P2.8 — also pull `description` (column added by migration
  // 20260512100000). Same `as never` pattern as currency_code.
  const { data: extraRow } = await ctx.supabase
    .from("salons")
    .select("currency_code, description" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const extraData = (extraRow ?? null) as {
    currency_code?: unknown;
    description?: unknown;
  } | null;
  const initialCurrency = parseCurrency(extraData?.currency_code);
  const initialDescription =
    typeof extraData?.description === "string"
      ? extraData.description
      : "";

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 sm:pt-6">
        <SetupBackNav slug={slug} title="Địa chỉ tiệm · Salon address" />
        <AddressSetupPanel
          slug={slug}
          initialAddress={ctx.salon.address ?? ""}
          initialSalonPhone={ctx.salon.salon_phone ?? ""}
          initialCurrency={initialCurrency}
          initialDescription={initialDescription}
        />
      </MobileStack>
    </ResponsiveShell>
  );
}
