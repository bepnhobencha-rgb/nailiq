import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";

import {
  loadWaitlistClaimPreview,
  parseWaitlistClaimToken,
} from "@/shared/booking/waitlistClaim";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { WaitlistClaimButton } from "./WaitlistClaimButton";

type Props = { searchParams: Promise<{ token?: string }> };

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function WaitlistClaimPage({ searchParams }: Props) {
  const { token: rawToken } = await searchParams;
  const token = parseWaitlistClaimToken(rawToken);
  if (!token) return <Shell><Unavailable /></Shell>;

  const incoming = await headers();
  const rateRequest = new Request("https://nailiq.local/booking/waitlist-claim", {
    headers: incoming,
  });
  const rate = await consumeBookingManagementRateLimit({
    request: rateRequest,
    tokenId: token,
    action: "waitlist_claim",
    phase: "inspect",
  });
  if (rate !== "allowed") {
    return <Shell><Result title="Please try again" message="We could not check this claim link right now." /></Shell>;
  }

  // GET/page render is inspection only. Only the explicit client-side POST in
  // WaitlistClaimButton can cross the claim mutation boundary.
  const preview = await loadWaitlistClaimPreview(token);
  if (preview.state === "error") {
    return (
      <Shell>
        <Result title="Please try again" message="We could not check this claim link right now." />
      </Shell>
    );
  }
  if (preview.state !== "available") return <Shell><Unavailable /></Shell>;

  return <Shell><WaitlistClaimButton token={token} /></Shell>;
}

function Unavailable() {
  return <Result title="Slot unavailable" message="This claim link is no longer available." />;
}

function Result({ title, message }: { title: string; message: string }) {
  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold text-white">{title}</h1>
      <p className="mt-3 text-sm text-nq-muted">{message}</p>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-nq-bg px-4">
      <div className="w-full max-w-sm rounded-2xl border border-nq-border/40 bg-nq-surface p-8">
        {children}
        <p className="mt-8 text-center text-xs text-nq-muted/50">
          Powered by{" "}
          <Link href="https://nailiq.ca" className="underline">
            NailIQ
          </Link>
        </p>
      </div>
    </div>
  );
}
