import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { loadCustomerWaitState } from "@/shared/booking/loadCustomerWaitState";

import { CustomerWaitClient } from "./CustomerWaitClient";

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
    notFound();
  }

  return (
    <CustomerWaitClient
      slug={slug}
      bookingId={bookingId}
      initialState={initial}
    />
  );
}
