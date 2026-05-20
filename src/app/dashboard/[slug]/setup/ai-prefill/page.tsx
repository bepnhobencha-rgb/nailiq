import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { AIPrefillWizard } from "@/components/dashboard/AIPrefillWizard";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Setup · Import Services · ${slug}`,
    description: "Import your nail salon services from a menu photo using AI.",
  };
}

export default async function AIPrefillPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) redirect("/register");

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 sm:pt-6">
        <SetupBackNav slug={slug} title="Import Services · AI" />
        <AIPrefillWizard slug={slug} />
      </MobileStack>
    </ResponsiveShell>
  );
}
