import type { Metadata } from "next";

import { loadCustomerWaitState } from "@/shared/booking/loadCustomerWaitState";

import { CustomerWaitClient } from "./CustomerWaitClient";
import { CustomerWaitNotFound } from "./CustomerWaitNotFound";

/** Realtime UI — never serve a stale cached version. */
export const dynamic = "force-dynamic";

type WaitPageProps = {
  params: Promise<{ slug: string; bookingId: string }>;
};

export async function generateMetadata({
  params,
}: WaitPageProps): Promise<Metadata> {
  const { slug, bookingId } = await params;
  const r = await loadCustomerWaitState(slug, bookingId);
  if (!r.ok) {
    return {
      title: { absolute: "Wait status | NailIQ" },
      robots: { index: false, follow: false },
    };
  }
  return {
    title: { absolute: `${r.salon.name} — Wait status` },
    robots: { index: false, follow: false },
  };
}

export default async function CustomerWaitPage({ params }: WaitPageProps) {
  const { slug, bookingId } = await params;
  const initial = await loadCustomerWaitState(slug, bookingId);

  if (!initial.ok) {
    // Render a friendly "we can't find your booking" screen rather
    // than a generic 404. The customer arrived here from a QR / SMS
    // and seeing a hard 404 reads as "the salon's link is broken"
    // rather than "this booking expired" — which is the actual
    // failure mode 99% of the time.
    return <CustomerWaitNotFound reason={initial.error} slug={slug} />;
  }

  return (
    <CustomerWaitClient
      slug={slug}
      bookingId={bookingId}
      initialState={initial}
    />
  );
}
