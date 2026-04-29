import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { ServicesSetupPanel } from "@/components/dashboard/ServicesSetupPanel";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Setup · Services · ${slug}`,
    description: "Manage your salon service menu.",
  };
}

export default async function SetupServicesPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }

  const { data: rows, error } = await ctx.supabase
    .from("services")
    .select("id, name, price_cents, duration_minutes, buffer_minutes")
    .eq("salon_id", ctx.salon.id)
    .order("name", { ascending: true });

  if (error) {
    console.error("[setup/services]", error);
    redirect("/register");
  }

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 sm:pt-6">
        <SetupBackNav slug={slug} title="Services" />
        <ServicesSetupPanel
          slug={slug}
          initialRows={(rows ?? []).map((r) => ({
            id: String(r.id),
            name: String(r.name ?? ""),
            price_cents: Number(r.price_cents ?? 0),
            duration_minutes: Number(r.duration_minutes ?? 0),
            buffer_minutes: Number(r.buffer_minutes ?? 0),
          }))}
        />
      </MobileStack>
    </ResponsiveShell>
  );
}
