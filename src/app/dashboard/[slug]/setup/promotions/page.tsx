import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { PromotionsSetupPanel } from "@/components/dashboard/PromotionsSetupPanel";
import { loadPromotionsData } from "./actions";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Setup · Promotions · ${slug}`,
    description: "Create and manage time-limited promotions and discounts.",
  };
}

export default async function SetupPromotionsPage({ params }: Props) {
  const { slug } = await params;
  const data = await loadPromotionsData(slug);
  if (!data) redirect("/register");

  return (
    <ResponsiveShell>
      <MobileStack>
        <SetupBackNav slug={slug} title="Promotions & discounts" />
        <PromotionsSetupPanel
          slug={slug}
          initialPromos={data.promos}
          initialSvcRules={data.svcRules}
          services={data.services}
        />
      </MobileStack>
    </ResponsiveShell>
  );
}
