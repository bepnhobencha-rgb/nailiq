/**
 * /party/[token] — Public party link page.
 *
 * No auth required.  The token is an opaque, unguessable 16-hex-char string.
 * Server component loads safe data (no phone numbers), then mounts the
 * interactive PartyClaimClient for the claim form.
 */

import type { Metadata } from "next";
import { loadPartyLinkPage } from "@/shared/booking/partyLinkActions";
import PartyClaimClient from "./_components/PartyClaimClient";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const data = await loadPartyLinkPage(token);
  if (!data) {
    return { title: "Group Booking · NailIQ", robots: { index: false, follow: false } };
  }
  return {
    title: `Group Booking at ${data.salonName} · NailIQ`,
    description: `You've been invited to a group booking at ${data.salonName}. Claim your slot!`,
    robots: { index: false, follow: false },
  };
}

export default async function PartyLinkPage({ params }: Props) {
  const { token } = await params;
  const data = await loadPartyLinkPage(token);

  if (!data) {
    return <PartyErrorPage reason="not_found" />;
  }

  return (
    <main className="min-h-screen bg-[#f9f5f2] py-10 px-4">
      <div className="mx-auto max-w-lg">
        {/* Header */}
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-gray-900">You&apos;re invited!</h1>
          <p className="mt-1 text-sm text-gray-500">
            Group booking at{" "}
            <span className="font-semibold text-gray-700">{data.salonName}</span>
          </p>
        </div>

        {/* Group summary card */}
        <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-gray-500 uppercase tracking-wide">
            {data.groupDateDisplay}
          </p>
          <p className="mt-1 text-lg font-semibold text-gray-900">
            {data.groupStartDisplay} – {data.groupEndDisplay}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            {data.mode === "sync_finish" ? "Everyone finishes together" : "Everyone starts together"}
          </p>
        </div>

        {/* Expired banner */}
        {data.expired && (
          <div className="mb-4 rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
            This party link has expired. Please ask the organiser to share a new one.
          </div>
        )}

        {/* Slot list + claim forms */}
        <PartyClaimClient data={data} />
      </div>
    </main>
  );
}

// ─── Error states ─────────────────────────────────────────────────

function PartyErrorPage({ reason }: { reason: "not_found" | "expired" }) {
  return (
    <main className="min-h-screen bg-[#f9f5f2] flex items-center justify-center px-4">
      <div className="text-center max-w-sm">
        <div className="text-4xl mb-4">💅</div>
        {reason === "not_found" ? (
          <>
            <h1 className="text-xl font-bold text-gray-900">Link not found</h1>
            <p className="mt-2 text-sm text-gray-500">
              This party link doesn&apos;t exist or may have already expired.
              Ask the organiser to resend it.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold text-gray-900">Link expired</h1>
            <p className="mt-2 text-sm text-gray-500">
              This party link has passed its 24-hour window. Ask the organiser to share
              a new booking.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
