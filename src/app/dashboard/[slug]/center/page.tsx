import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ReceptionistCenter } from "@/components/receptionist/ReceptionistCenter";
import { ReceptionistErrorBoundary } from "@/components/receptionist/ReceptionistErrorBoundary";
import { loadReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { userEn } from "@/shared/i18n/user";
import { salonToday } from "@/shared/lib/salonTime";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Tiếp Tân · ${slug}`,
    robots: "noindex",
  };
}

export default async function ReceptionistCenterPage({
  params,
  searchParams,
}: PageProps) {
  const { slug } = await params;
  const { date } = await searchParams;

  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) {
    redirect("/register");
  }

  const dateOk = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date);

  let targetDate: string;
  if (dateOk) {
    targetDate = date;
  } else {
    const tzResult = await ctx.supabase
      .from("salons")
      .select("timezone")
      .eq("id", ctx.salon.id)
      .maybeSingle();

    const tz =
      tzResult.data?.timezone != null
        ? String(tzResult.data.timezone).trim()
        : "";
    if (!tz) {
      redirect(`/dashboard/${encodeURIComponent(slug)}`);
    }
    targetDate = salonToday(tz);
  }

  const initialResult = await loadReceptionistCenterData(slug, targetDate);

  if (!initialResult.ok && initialResult.error === "unauthorized") {
    redirect("/register");
  }

  // Error-boundary labels are sourced server-side from English (the
  // primary product language per UX_PRINCIPLES §7). The boundary
  // surface is rare; a follow-up can fold a client wrapper that
  // reads `useUserLanguage` for VI parity if real-world incidents
  // make that worthwhile.
  return (
    <ReceptionistErrorBoundary
      labels={userEn.receptionist.errorBoundary}
      salonSlug={slug}
    >
      <ReceptionistCenter
        slug={slug}
        initialResult={initialResult}
        viewerRole={ctx.role}
      />
    </ReceptionistErrorBoundary>
  );
}
