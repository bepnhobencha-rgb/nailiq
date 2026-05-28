import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ReceptionistCenter } from "@/components/receptionist/ReceptionistCenter";
import { ReceptionistErrorBoundary } from "@/components/receptionist/ReceptionistErrorBoundary";
import { loadBookingLimitStatus } from "@/shared/dashboard/loadBookingLimitStatus";
import { loadReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
import { loadPartyCardsAction } from "@/shared/dashboard/loadPartyCardsAction";
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

  // Perf — `resolveSalonForDashboard` now fetches `timezone` alongside
  // the rest of the salon row, so we can compute today without a
  // dedicated round-trip. Previously this page issued THREE separate
  // `salons` queries per request (auth, this timezone lookup, and
  // `loadReceptionistCenterData`'s own fetch). The pre-fetched salon
  // is also handed to the loader below so it can skip its own fetch.
  const tz = ctx.salon.timezone.trim();
  if (!tz) {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }
  const dateOk = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const targetDate = dateOk ? date : salonToday(tz);

  const [initialResult, limitResult, partyCardsResult] = await Promise.all([
    loadReceptionistCenterData(slug, targetDate, {
      preFetchedSalon: ctx.salon,
    }),
    loadBookingLimitStatus(slug),
    loadPartyCardsAction(slug),
  ]);
  const bookingLimitStatus = limitResult.ok ? limitResult.status : null;

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
        bookingLimitStatus={bookingLimitStatus}
        partyCards={partyCardsResult.ok ? partyCardsResult.cards : []}
      />
    </ReceptionistErrorBoundary>
  );
}
