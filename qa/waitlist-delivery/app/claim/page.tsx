import type { Metadata } from "next";
import { WaitlistClaimButton } from "@/app/booking/waitlist-claim/WaitlistClaimButton";

export const metadata: Metadata = {
  title: "NailIQ — Synthetic Waitlist Claim QA",
  robots: { index: false, follow: false },
};

// Browser fixture only: no loader, database, capability issuance, or API route.
// API responses are intercepted by the test; production GET inspection is
// covered separately by the real local HTTP/PostgreSQL evidence in B54.
export default async function ClaimFixture({ searchParams }: {
  searchParams: Promise<{ available?: string; other?: string }>;
}) {
  const params = await searchParams;
  const token = params.other === "1"
    ? "00000000-0000-4000-8000-000000000002"
    : "00000000-0000-4000-8000-000000000001";
  return (
    <main className="flex min-h-screen items-center justify-center bg-nq-bg px-4">
      <div className="w-full max-w-sm rounded-2xl border border-nq-border/40 bg-nq-surface p-8">
        <WaitlistClaimButton key={token} token={token} isAvailable={params.available !== "0"} />
      </div>
    </main>
  );
}
