import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ReceptionistCenter } from "@/components/receptionist/ReceptionistCenter";
import { loadReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
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

  return (
    <ReceptionistCenter
      slug={slug}
      initialResult={initialResult}
      viewerRole={ctx.role}
    />
  );
}
