import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MobileStack } from "@/components/layout/MobileStack";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { SetupBackNav } from "@/components/dashboard/SetupBackNav";
import { StaffSetupPanel } from "@/components/dashboard/StaffSetupPanel";
import { getUserMessages } from "@/shared/i18n/user";
import { resolveUserLanguage } from "@/shared/i18n/user/resolveUserLanguage";
import {
  getDashboardWriteClient,
  type StaffJobRole,
} from "@/shared/dashboard/setupActions";
import {
  loadTeamAccessMap,
  type StaffAccessInfo,
} from "@/shared/dashboard/staffAccess";
import { getEffectivePlanLimits } from "@/shared/lib/subscriptionPlans";

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

  const language = await resolveUserLanguage();
  const t = getUserMessages(language);

  const [staffResult, servicesResult] = await Promise.all([
    ctx.supabase
      .from("staff")
      .select("id, name, job_role, status, user_id")
      .eq("salon_id", ctx.salon.id)
      .is("deleted_at" as never, null)
      .order("name", { ascending: true }),
    ctx.supabase
      .from("services")
      .select("id, name")
      .eq("salon_id", ctx.salon.id)
      .is("deleted_at" as never, null)
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

  // Same plan-limit plumbing as the services page — UX gate only; the
  // server still re-enforces via `canAddStaff`.
  const { data: planRow } = await ctx.supabase
    .from("salons")
    .select(
      "subscription_plan, plan_override, feature_flags" as never,
    )
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const planForLimits = (planRow ?? {}) as {
    subscription_plan?: string | null;
    plan_override?: string | null;
    feature_flags?: Record<string, unknown> | null;
  };
  const planLimits = getEffectivePlanLimits(planForLimits);
  const maxStaff = Number.isFinite(planLimits.maxStaff)
    ? planLimits.maxStaff
    : Number.POSITIVE_INFINITY;

  // Login/permission info per staff member (service-role read — salon_members
  // RLS only exposes the caller's own row, so the owner couldn't otherwise see
  // the whole team's access). Resolve only the members that actually have a
  // linked login, so cost scales with team size — not the whole project.
  const linkedUserIds = staffRows
    .map((r) => ("user_id" in r ? (r as { user_id?: unknown }).user_id : undefined))
    .filter((v): v is string => typeof v === "string");
  const accessMap = await loadTeamAccessMap(ctx.salon.id, linkedUserIds);
  const accessByStaff: Record<string, StaffAccessInfo | null> = {};
  for (const r of staffRows) {
    const uid =
      "user_id" in r ? (r as { user_id?: unknown }).user_id : undefined;
    accessByStaff[String(r.id)] =
      typeof uid === "string" ? (accessMap[uid] ?? null) : null;
  }

  return (
    <ResponsiveShell>
      <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-4 sm:pt-6">
        <SetupBackNav slug={slug} title={t.setupLabels.staffTitle} />
        <StaffSetupPanel
          slug={slug}
          maxStaff={maxStaff}
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
          accessByStaff={accessByStaff}
          currentUserRole={ctx.role}
        />
      </MobileStack>
    </ResponsiveShell>
  );
}
