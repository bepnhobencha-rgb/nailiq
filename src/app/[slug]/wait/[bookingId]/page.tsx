import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ statusToken?: string; managementToken?: string }>;
};

/**
 * Legacy naked-booking-id URLs never load booking data and never mint a new
 * capability. A transitional caller that already has a status capability may
 * be redirected; otherwise the old URL fails closed with no data disclosure.
 */
export default async function LegacyBookingWaitPage({ searchParams }: Props) {
  const query = await searchParams;
  const statusToken = (query.statusToken ?? query.managementToken ?? "").trim();
  if (statusToken) redirect(`/booking/status?token=${encodeURIComponent(statusToken)}`);

  return (
    <main className="flex min-h-screen items-center justify-center bg-nq-bg px-4">
      <div className="max-w-sm rounded-2xl border border-nq-border/40 bg-nq-surface p-8 text-center">
        <h1 className="text-xl font-semibold text-white">Link Unavailable</h1>
        <p className="mt-3 text-sm text-nq-muted">
          For your privacy, this older appointment link no longer displays booking details.
          Please use the latest link from your salon.
        </p>
      </div>
    </main>
  );
}
