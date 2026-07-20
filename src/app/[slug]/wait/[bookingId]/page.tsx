import type { Metadata } from "next";

import { loadCustomerWaitState } from "@/shared/booking/loadCustomerWaitState";
import { generateReminderToken } from "@/shared/noshow/generateReminderToken";

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

  // Manage links. The booking-confirmation SMS points customers here and its
  // code comment has always claimed this is "the /wait page which has
  // Reschedule + Cancel buttons" — but the buttons were never built, so the
  // link was a dead end. The token flow already exists (it is what the
  // confirmation EMAIL links to), so this reuses it rather than inventing a
  // second mechanism.
  //
  // generateReminderToken returns an existing unexpired token when there is
  // one, so refreshing this page does not mint a new token every time.
  const s = initial.booking.status;
  let manageLinks: { reschedule: string; cancel: string } | null = null;
  if (s !== "cancelled" && s !== "completed" && s !== "no_show") {
    const token = await generateReminderToken(bookingId, initial.salon.id);
    if (token) {
      manageLinks = {
        reschedule: `/booking/reschedule?token=${token.id}`,
        cancel: `/booking/cancel?token=${token.id}`,
      };
    }
  }

  return (
    <CustomerWaitClient
      slug={slug}
      bookingId={bookingId}
      initialState={initial}
      manageLinks={manageLinks}
    />
  );
}
