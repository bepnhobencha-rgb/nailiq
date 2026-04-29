import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { StaffSetupPanel } from "@/components/dashboard/StaffSetupPanel";
import {
  getDashboardWriteClient,
  type StaffJobRole,
} from "@/shared/dashboard/setupActions";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Setup · Staff · ${slug}`,
    description: "Manage staff who take bookings.",
  };
}

function normalizeRole(raw: unknown): StaffJobRole {
  if (raw === "owner" || raw === "senior" || raw === "nail_tech") {
    return raw;
  }
  return "nail_tech";
}

export default async function SetupStaffPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }

  const { data: rows, error } = await ctx.supabase
    .from("staff")
    .select("id, name, job_role")
    .eq("salon_id", ctx.salon.id)
    .order("name", { ascending: true });

  if (error) {
    console.error("[setup/staff]", error);
    redirect("/register");
  }

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 sm:pt-6">
        <SetupBackNav slug={slug} title="Staff" />
        <StaffSetupPanel
          slug={slug}
          initialRows={(rows ?? []).map((r) => ({
            id: String(r.id),
            name: String(r.name ?? ""),
            job_role: normalizeRole(
              "job_role" in r ? (r as { job_role?: unknown }).job_role : undefined,
            ),
          }))}
        />
      </MobileStack>
    </ResponsiveShell>
  );
}
