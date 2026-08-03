import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { formatUsd, getPrivateOffer } from "@/shared/sales/privateOffers";
import { startPrivateOfferCheckout } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "NailIQ personalized service agreement",
  robots: { index: false, follow: false, nocache: true },
};

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; checkout?: string }>;
};

const errorCopy: Record<string, string> = {
  signer: "Enter the authorized signer's full legal name.",
  title: "Enter the authorized signer's business title.",
  business: "Enter the business's full legal name.",
  email: "The email must match the salon administrator email on this offer.",
  agreement: "Accept all agreement confirmations before continuing.",
  "already-active": "This salon already has an active Stripe subscription.",
  salon: "This offer could not be matched to the salon record.",
  stripe: "Stripe Checkout could not be opened. No charge was made.",
};

export default async function PrivateOfferPage({ params, searchParams }: Props) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  const offer = getPrivateOffer(token);
  if (!offer) notFound();
  const action = startPrivateOfferCheckout.bind(null, offer.accessKey);
  const monthly = formatUsd(offer.monthlyAmountCents);
  const annual = formatUsd(offer.annualAmountCents);

  return (
    <main className="min-h-screen bg-[#f4f8f5] px-5 py-10 text-[#17201b]">
      <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <section className="rounded-[2rem] bg-[#10251b] p-8 text-white shadow-2xl">
          <p className="text-lg font-semibold">NailIQ</p>
          <p className="mt-14 text-sm font-semibold uppercase tracking-[0.18em] text-[#a9dfbf]">Prepared for · Chuẩn bị cho</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">{offer.salonName}</h1>
          <p className="mt-5 leading-7 text-white/70">Managed website, booking, staff scheduling, front desk, training and ongoing support.</p>
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            <div className="rounded-2xl border border-white/12 bg-white/7 p-5">
              <p className="text-xs uppercase tracking-[0.14em] text-white/55">Monthly · Hằng tháng</p>
              <p className="mt-2 text-3xl font-semibold">{monthly} USD</p>
            </div>
            <div className="rounded-2xl border border-white/12 bg-white/7 p-5">
              <p className="text-xs uppercase tracking-[0.14em] text-white/55">Annual · Hằng năm</p>
              <p className="mt-2 text-3xl font-semibold">{annual} USD</p>
              <p className="mt-1 text-sm text-white/55">12-month initial term · Save two months</p>
            </div>
          </div>
          <p className="mt-8 text-sm leading-6 text-white/55">Standard setup $299 − founding-customer discount $299 = $0 due.</p>
        </section>

        <section className="rounded-[2rem] border border-black/8 bg-white p-7 shadow-lg sm:p-9">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#47705c]">Service agreement · Hợp đồng dịch vụ</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em]">Review, accept and continue to secure payment</h2>
          {query.error ? <p role="alert" className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-800">{errorCopy[query.error] ?? "Please review the form and try again."}</p> : null}
          {query.checkout === "cancelled" ? <p role="status" className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">Checkout was cancelled. No charge was made.</p> : null}

          <div className="mt-6 space-y-4 text-sm leading-6 text-black/68">
            <p><strong>Initial term:</strong> 12 months beginning after Stripe confirms the first successful payment.</p>
            <p><strong>Billing:</strong> Choose {monthly} USD monthly for 12 months, or {annual} USD once for the full initial term. Monthly billing is a payment schedule, not a month-to-month agreement.</p>
            <p><strong>Renewal:</strong> After the initial term, service renews under the selected schedule at the same price unless either party gives at least 30 days&apos; written notice.</p>
            <p><strong>Early termination:</strong> Reduced or discontinued use does not end the initial-term commitment. NailIQ may agree in writing to an early release. Material breach by NailIQ is subject to a 30-day written cure period.</p>
            <p><strong>Included:</strong> Salon website, online booking, Front Desk, staff and service setup, training, managed support, and up to 250 SMS segments monthly under fair-use terms.</p>
            <p>Prices exclude applicable taxes. Stripe securely handles card details. Support and cancellation requests: support@nailiq.ca.</p>
          </div>

          <form action={action} className="mt-7 space-y-4">
            <fieldset className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-semibold">Billing schedule · Lịch thanh toán</legend>
              <label className="rounded-xl border border-black/12 p-4"><input name="billingSchedule" type="radio" value="monthly" defaultChecked className="mr-2" />{monthly}/month</label>
              <label className="rounded-xl border border-black/12 p-4"><input name="billingSchedule" type="radio" value="annual" className="mr-2" />{annual}/year</label>
            </fieldset>
            {[
              ["signerName", "Authorized signer’s full legal name"],
              ["signerTitle", "Business title"],
              ["businessLegalName", "Business legal name"],
              ["signerEmail", "Salon administrator email"],
            ].map(([name, label]) => (
              <label key={name} className="block text-sm font-semibold">{label}<input name={name} required type={name === "signerEmail" ? "email" : "text"} autoComplete={name === "signerEmail" ? "email" : "off"} className="mt-2 w-full rounded-xl border border-black/15 px-4 py-3 text-base font-normal outline-none focus:border-[#2d7650]" /></label>
            ))}
            <label className="flex gap-3 rounded-xl border border-black/10 p-4 text-sm leading-6"><input name="authorityAccepted" value="yes" type="checkbox" required className="mt-1" />I confirm I am authorized to bind the business named above.</label>
            <label className="flex gap-3 rounded-xl border border-black/10 p-4 text-sm leading-6"><input name="agreementAccepted" value="yes" type="checkbox" required className="mt-1" />I accept this personalized service agreement and its fixed 12-month initial term.</label>
            <label className="flex gap-3 rounded-xl border border-black/10 p-4 text-sm leading-6"><input name="renewalAccepted" value="yes" type="checkbox" required className="mt-1" />I separately consent to recurring billing and automatic renewal, subject to 30 days&apos; written notice.</label>
            <button type="submit" className="min-h-14 w-full rounded-xl bg-[#153e2a] px-6 py-4 font-semibold text-white">Accept and continue to secure Stripe payment</button>
            <p className="text-center text-xs text-black/48">No charge occurs until the amount is reviewed and confirmed on Stripe.</p>
          </form>
        </section>
      </div>
    </main>
  );
}
