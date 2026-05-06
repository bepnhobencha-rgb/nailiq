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

function normalizeStatus(raw: unknown): "active" | "pending" | "inactive" {
  if (raw === "pending" || raw === "inactive") return raw;
  return "active";
}

export default async function SetupStaffPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }

  const [staffResult, servicesResult] = await Promise.all([
    ctx.supabase
      .from("staff")
      .select("id, name, job_role, status")
      .eq("salon_id", ctx.salon.id)
      .order("name", { ascending: true }),
    ctx.supabase
      .from("services")
      .select("id, name")
      .eq("salon_id", ctx.salon.id)
      .order("name", { ascending: true }),
  ]);

  if (staffResult.error || servicesResult.error) {
    console.error("[setup/staff]", staffResult.error ?? servicesResult.error);
    redirect("/register");
  }

  const staffRows = staffResult.data ?? [];
  const services = (servicesResult.data ?? []).map((s) => ({
    id: String(s.id),
    name: String(s.name ?? ""),
  }));

  let capabilityRows: { staff_id: string; service_id: string }[] = [];
  if (staffRows.length > 0) {
    const staffIds = staffRows.map((r) => String(r.id));
    const { data: capRows, error: capErr } = await ctx.supabase
      .from("staff_services")
      .select("staff_id, service_id")
      .in("staff_id", staffIds);
    if (capErr) {
      console.error("[setup/staff] staff_services", capErr);
    } else {
      capabilityRows = (capRows ?? []).map((r) => ({
        staff_id: String(r.staff_id),
        service_id: String(r.service_id),
      }));
    }
  }

  /** initialServiceIdsByStaff[staffId] is the *current* whitelist for that
   *  staff. The panel applies the "salon has zero rows → all-checked" UI
   *  default when it sees `capabilityRows` is empty across the salon. */
  const initialServiceIdsByStaff: Record<string, string[]> = {};
  for (const row of capabilityRows) {
    (initialServiceIdsByStaff[row.staff_id] ??= []).push(row.service_id);
  }

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 sm:pt-6">
        <SetupBackNav slug={slug} title="Staff" />
        <StaffSetupPanel
          slug={slug}
          initialRows={staffRows.map((r) => ({
            id: String(r.id),
            name: String(r.name ?? ""),
            job_role: normalizeRole(
              "job_role" in r ? (r as { job_role?: unknown }).job_role : undefined,
            ),
            status: normalizeStatus(
              "status" in r ? (r as { status?: unknown }).status : undefined,
            ),
          }))}
          services={services}
          initialServiceIdsByStaff={initialServiceIdsByStaff}
          salonHasCapabilityRows={capabilityRows.length > 0}
        />
      </MobileStack>
    </ResponsiveShell>
  );
}
