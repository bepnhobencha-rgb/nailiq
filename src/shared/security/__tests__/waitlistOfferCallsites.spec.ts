import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const canonicalHelper = read("src/shared/noshow/promoteAndDeliverWaitlistOffer.ts");
const cron = read("src/app/api/cron/waitlist-advance/route.ts");
const twilio = read("src/app/api/twilio/inbound/route.ts");
const receptionist = read("src/shared/dashboard/receptionistActions.ts");
const productionCallers = [cron, twilio, receptionist].join("\n");

function expectCanonicalOffer(source: string, label: string) {
  expect(
    /notifyWaitlistForSlot|notify_waitlist_for_no_show|advance_waitlist_notifications/.test(source),
    `${label} still calls a legacy waitlist notification helper`,
  ).toBe(false);
  expect(
    /deliverPromotedWaitlistOffer|deliverWaitlistOffer|claimCapabilityToken/.test(source),
    `${label} does not consume an exact capability-bearing offer`,
  ).toBe(true);
}

describe("waitlist offer production callsites", () => {
  it("never emits a browser link from booking_waitlist_entries.claim_token", () => {
    expect(/waitlist-claim\?token=\$\{(?:row\.)?claim_token\}/.test(productionCallers)).toBe(false);
    expect(/waitlist-claim\?token=\$\{token\}/.test(productionCallers)).toBe(false);
    expect(/notifyWaitlistForSlot/.test(productionCallers)).toBe(false);
  });

  it("cron advances canonical capabilities and delivers each exact returned offer", () => {
    expect(/advance_waitlist_offer_capabilities/.test(cron + canonicalHelper)).toBe(true);
    expectCanonicalOffer(cron + canonicalHelper, "cron advance");
  });

  it("Twilio cancellation atomically returns and delivers the exact nested offer", () => {
    expect(/cancel_booking_by_id_with_waitlist_offer/.test(twilio)).toBe(true);
    expect(/deliverCanonicalWaitlistPromotion\([\s\S]{0,120}promotedWaitlist/.test(twilio)).toBe(true);
    expectCanonicalOffer(twilio + canonicalHelper, "Twilio cancellation");
  });

  it("desk cancel/no-show promote by booking and manual invitation promotes the exact selected entry", () => {
    expect(/promoteAndDeliverWaitlistForBooking\([\s\S]{0,120}bookingId/.test(receptionist)).toBe(true);
    expect(/promote_waitlist_for_booking/.test(canonicalHelper)).toBe(true);
    expect(/promoteAndDeliverSpecificWaitlistEntry\(/.test(receptionist)).toBe(true);
    expect(/promote_waitlist_entry/.test(canonicalHelper)).toBe(true);
    expectCanonicalOffer(receptionist + canonicalHelper, "receptionist waitlist");
  });
});
