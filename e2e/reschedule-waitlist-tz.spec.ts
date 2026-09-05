/**
 * Customer reschedule → freed-slot waitlist promotion, salon-timezone date.
 *
 * Regression guard: `reschedule_booking_as_customer` matched the freed slot's
 * waitlist against the UTC day instead of the salon-LOCAL day. For an evening
 * booking at a North-American salon (e.g. 10pm PT = next-day UTC), the FIFO
 * lookup used a booking_date one day off → the waitlist entry never matched and
 * the freed slot's customer was never promoted. This seeds exactly that
 * cross-midnight-UTC case and asserts the waiting entry is flipped to 'notified'
 * by the reschedule.
 */
import { test, expect } from "@playwright/test";
import { cleanupTestSalon, seedTestSalon } from "./helpers/db";
import { createServiceRoleClient } from "../src/shared/lib/supabase/serviceRole";
import { salonWallTimeToUtcIso } from "../src/shared/lib/salonTime";

const SALON_TZ = "America/Los_Angeles";
const salonLocalYmd = (utcIso: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: SALON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(utcIso));

test.describe("Reschedule — freed-slot waitlist (salon tz)", () => {
  let testSlug: string;
  let salonId: string;
  let waitlistEntryId: string;
  let tokenId: string;

  test.beforeEach(async () => {
    const { slug, salonId: id } = await seedTestSalon({
      slug: "e2e-reschedule-waitlist-tz",
      name: "E2E Reschedule TZ Salon",
      phone: "16045551210",
    });
    testSlug = slug;
    salonId = id;

    const supabase = createServiceRoleClient();
    await supabase.from("salons").update({ timezone: SALON_TZ }).eq("id", salonId);

    const { data: svc } = await supabase
      .from("services").select("id").eq("salon_id", salonId).limit(1).maybeSingle();
    const { data: stf } = await supabase
      .from("staff").select("id").eq("salon_id", salonId).limit(1).maybeSingle();
    const serviceId = (svc as { id: string }).id;
    const staffId = (stf as { id: string }).id;

    // Original booking at 05:00 UTC ~3 days out → 22:00 the PREVIOUS day in PT.
    // So its salon-local date is one day BEFORE its UTC date — the exact skew
    // the bug tripped on.
    const origUtc = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    origUtc.setUTCHours(5, 0, 0, 0);
    const origUtcIso = origUtc.toISOString();
    const localYmd = salonLocalYmd(origUtcIso);
    const utcYmd = origUtcIso.split("T")[0];
    // Guard the fixture actually straddles the UTC/salon-local boundary.
    expect(localYmd).not.toBe(utcYmd);

    const { data: booking } = await supabase
      .from("bookings")
      .insert({
        salon_id: salonId,
        service_id: serviceId,
        staff_id: staffId,
        client_name: "Reschedule Client",
        client_phone: "6045559210",
        start_time_utc: origUtcIso,
        end_time_utc: new Date(origUtc.getTime() + 60 * 60 * 1000).toISOString(),
        status: "confirmed",
      })
      .select("id").single();
    const bookingId = (booking as { id: string }).id;

    const { data: token } = await supabase
      .from("booking_reminder_tokens" as never)
      .insert({
        booking_id: bookingId,
        salon_id: salonId,
        expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      })
      .select("id").single();
    tokenId = (token as unknown as { id: string }).id;

    // Waiting entry for the freed slot, keyed by the SALON-LOCAL date.
    const { data: wl } = await supabase
      .from("booking_waitlist_entries" as never)
      .insert({
        salon_id: salonId,
        service_id: serviceId,
        booking_date: localYmd,
        client_name: "Waitlist Person",
        client_phone: "16045551211",
        status: "waiting",
        source: "slot_unavailable",
      })
      .select("id").single();
    waitlistEntryId = (wl as unknown as { id: string }).id;
  });

  test.afterEach(async () => {
    await cleanupTestSalon(testSlug);
  });

  test("rescheduling an evening booking promotes the salon-local-date waitlister", async ({
    page,
  }) => {
    // Reschedule to any valid future slot; the target time is irrelevant — the
    // fix concerns which OLD-slot waitlist entry gets promoted.
    const newDate = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    const newStartUtc = salonWallTimeToUtcIso(newDate, 14 * 60, SALON_TZ);
    const newEndUtc = new Date(
      Date.parse(newStartUtc) + 60 * 60 * 1000,
    ).toISOString();
    const res = await page.request.post("/api/booking/reschedule-action", {
      headers: {
        origin: process.env.BASE_URL ?? "http://127.0.0.1:3000",
      },
      data: {
        token: tokenId,
        requestId: crypto.randomUUID(),
        date: newDate,
        slotLabel: "2:00 PM",
        newStartUtc,
        newEndUtc,
      },
    });
    const json = (await res.json()) as { ok?: boolean; code?: string };
    expect(json.ok, `reschedule failed: ${JSON.stringify(json)}`).toBe(true);

    // The freed slot's waiting entry must now be 'notified'. Pre-fix it stayed
    // 'waiting' because the RPC looked under the UTC date.
    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from("booking_waitlist_entries" as never)
      .select("status, claim_token")
      .eq("id", waitlistEntryId)
      .maybeSingle();
    const row = data as { status: string; claim_token: string | null } | null;
    expect(row?.status).toBe("notified");
    expect(row?.claim_token).not.toBeNull();
  });
});
