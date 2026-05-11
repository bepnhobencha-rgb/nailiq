import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { ServicesSetupPanel } from "@/components/dashboard/ServicesSetupPanel";
import { parseServiceCategory } from "@/shared/booking/serviceCategory";
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
    // `category`, `description`, `is_popular`, `is_featured` were added
    // by migrations 20260511500000 + 20260511600000; not yet in the
    // auto-generated DB types so the SELECT spread is cast.
    .select(
      "id, name, price_cents, duration_minutes, buffer_minutes, category, description, is_popular, is_featured" as never,
    )
    .eq("salon_id", ctx.salon.id)
    .is("deleted_at" as never, null)
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
          initialRows={(rows ?? []).map((r) => {
            const row = r as unknown as {
              id: string;
              name?: string;
              price_cents?: number;
              duration_minutes?: number;
              buffer_minutes?: number;
              category?: unknown;
              description?: unknown;
              is_popular?: unknown;
              is_featured?: unknown;
            };
            const descRaw = row.description;
            return {
              id: String(row.id),
              name: String(row.name ?? ""),
              price_cents: Number(row.price_cents ?? 0),
              duration_minutes: Number(row.duration_minutes ?? 0),
              buffer_minutes: Number(row.buffer_minutes ?? 0),
              category: parseServiceCategory(row.category),
              description:
                typeof descRaw === "string" && descRaw.trim().length > 0
                  ? descRaw.trim()
                  : null,
              is_popular: row.is_popular === true,
              is_featured: row.is_featured === true,
            };
          })}
        />
      </MobileStack>
    </ResponsiveShell>
  );
}
