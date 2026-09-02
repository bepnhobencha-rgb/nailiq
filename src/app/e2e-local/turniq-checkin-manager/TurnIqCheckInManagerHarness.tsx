"use client";

import { TurnIqCheckInLinkManager } from "@/app/dashboard/[slug]/turniq/check-in/TurnIqCheckInLinkManager";
import type {
  TurnIqIssueCheckInLinkInput,
  TurnIqIssueCheckInLinkResult,
  TurnIqRevokeCheckInLinkResult,
} from "@/shared/turniq/customerCheckInActions";

const BOOKING_ID = "11111111-1111-4111-8111-111111111111";
const CAPABILITY_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "33333333-3333-4333-8333-333333333333";

export function TurnIqCheckInManagerHarness({ shortExpiry }: { shortExpiry: boolean }) {
  async function issue(
    _slug: string,
    input: TurnIqIssueCheckInLinkInput,
  ): Promise<TurnIqIssueCheckInLinkResult> {
    const expiresAt = new Date(Date.now() + (shortExpiry ? 1_200 : 15 * 60_000)).toISOString();
    return {
      ok: true,
      capabilityId: CAPABILITY_ID,
      checkInPath: `/turniq/check-in?salon=synthetic-turniq&channel=${input.kind === "walkin_kiosk" ? "kiosk" : "qr"}#cap=${TOKEN}`,
      expiresAt,
      scope: input.kind === "walkin_kiosk" ? "walkin_kiosk" : "one_booking",
    };
  }

  async function revoke(
    _slug: string,
    capabilityId: string,
  ): Promise<TurnIqRevokeCheckInLinkResult> {
    return {
      ok: true,
      capabilityId,
      revokedAt: new Date().toISOString(),
      replayed: false,
    };
  }

  return (
    <main className="min-h-screen bg-nq-bg p-4 sm:p-8">
      <TurnIqCheckInLinkManager
        slug="synthetic-turniq"
        salonName="Synthetic TurnIQ Salon"
        bookings={[{
          id: BOOKING_ID,
          serviceName: "Classic Pedicure",
          startLabel: "2:30 PM",
          partySize: 2,
        }]}
        issueAction={issue}
        revokeAction={revoke}
      />
    </main>
  );
}
