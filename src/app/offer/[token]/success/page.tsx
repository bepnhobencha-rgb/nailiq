import Link from "next/link";
import { notFound } from "next/navigation";

import { getStripeClient } from "@/shared/lib/stripe";
import { getPrivateOffer } from "@/shared/sales/privateOffers";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }>; searchParams: Promise<{ session_id?: string }> };

export default async function OfferSuccessPage({ params, searchParams }: Props) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  const offer = getPrivateOffer(token);
  const sessionId = query.session_id?.trim() ?? "";
  if (!offer || !sessionId.startsWith("cs_")) notFound();
  const stripe = getStripeClient();
  if (!stripe) notFound();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.client_reference_id !== offer.salonId || session.metadata?.private_offer_key !== offer.accessKey) notFound();
  const complete = session.status === "complete";
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f4f8f5] px-5 py-12 text-[#17201b]">
      <section className="w-full max-w-xl rounded-3xl bg-white p-8 text-center shadow-xl">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#dff2e6] text-3xl text-[#1f6a45]">{complete ? "✓" : "…"}</div>
        <p className="mt-6 text-sm font-semibold uppercase tracking-[0.16em] text-[#47705c]">{offer.salonName}</p>
        <h1 className="mt-3 text-3xl font-semibold">{complete ? "Subscription confirmed · Đã xác nhận thanh toán" : "Stripe is finalizing your subscription"}</h1>
        <p className="mt-4 leading-7 text-black/62">Dashboard access is restored automatically after NailIQ receives Stripe&apos;s signed confirmation. If it remains locked briefly, refresh the Dashboard.</p>
        <Link href={`/dashboard/${encodeURIComponent(offer.salonSlug)}`} className="mt-8 inline-flex min-h-12 items-center justify-center rounded-xl bg-[#153e2a] px-6 py-3 font-semibold text-white">Return to Dashboard</Link>
      </section>
    </main>
  );
}
