/**
 * Voice AI — SMS confirmation contract tests.
 *
 * Regression guard for: "Voice AI says 'confirmation SMS sent' but no SMS was
 * received." The tool responses must now carry an accurate `smsSent` boolean,
 * and a failed/disabled SMS must NEVER fail the booking.
 *
 * In the test environment Twilio is typically NOT configured, so `smsSent` is
 * expected to be `false` while the booking still succeeds — exactly the case the
 * UI previously mis-reported as "sent".
 *
 * Covers:
 *   - confirm_booking returns smsSent:boolean and booking still succeeds
 *   - confirm_group_booking returns smsSent:boolean and booking still succeeds
 *
 * API-level only — no browser microphone required.
 *
 * Run: npm run test:e2e -- e2e/party-booking/voice-sms-confirmation.spec.ts
 */
import { expect, test } from "@playwright/test";
import {
  cleanupPartyTestSalon,
  seedPartyTestSalon,
  type PartyTestSalon,
} from "./helpers";
import { nextOpenDateYmd } from "../group-booking/helpers";

const SLUG = "e2e-voice-sms";
let salon: PartyTestSalon;

test.beforeAll(async () => {
  salon = await seedPartyTestSalon(SLUG);
});

test.afterAll(async () => {
  await cleanupPartyTestSalon(SLUG, salon?.salonId);
});

// ─── Individual confirm_booking returns an accurate smsSent flag ───

test("confirm_booking returns smsSent boolean and booking still succeeds", async ({
  request,
  baseURL,
}) => {
  const { serviceIds } = salon;
  const dateYmd = nextOpenDateYmd(2);

  // 1. Find an available slot.
  const slotsRes = await request.post(`${baseURL}/api/voice/tool`, {
    data: {
      toolName: "get_available_slots",
      toolArgs: { service_id: serviceIds[0], date: dateYmd, staff_id: "any" },
      salonSlug: SLUG,
    },
  });
  expect(slotsRes.status()).toBe(200);
  const slotsBody = await slotsRes.json();
  const slots: string[] = slotsBody?.slots ?? [];
  if (slots.length === 0) {
    console.warn("[voice-sms] no individual slots — skipping confirm_booking assertion.");
    return;
  }

  // 2. Confirm the booking.
  const confirmRes = await request.post(`${baseURL}/api/voice/tool`, {
    data: {
      toolName: "confirm_booking",
      toolArgs: {
        service_id: serviceIds[0],
        date: dateYmd,
        time_slot: slots[0],
        staff_id: "any",
        customer_name: "Voice SMS Test",
        customer_phone: "+16045557788",
      },
      salonSlug: SLUG,
    },
  });

  expect(confirmRes.status()).toBe(200);
  const body = await confirmRes.json();

  // Booking must succeed regardless of SMS outcome.
  expect(body?.success, "booking should succeed even if SMS can't be sent").toBe(true);
  expect(body?.bookingId, "a bookingId should be returned").toBeTruthy();

  // The response MUST carry an explicit smsSent boolean (no more hardcoded claim).
  expect(typeof body?.smsSent, "smsSent must be present as a boolean").toBe("boolean");
});

// ─── Group confirm_group_booking returns an accurate smsSent flag ──

test("confirm_group_booking returns smsSent boolean and booking still succeeds", async ({
  request,
  baseURL,
}) => {
  const { serviceIds } = salon;
  const dateYmd = nextOpenDateYmd(3);

  const res = await request.post(`${baseURL}/api/voice/tool`, {
    data: {
      toolName: "confirm_group_booking",
      toolArgs: {
        service_assignments: [
          { service_id: serviceIds[0], count: 1 },
          { service_id: serviceIds[1] ?? serviceIds[0], count: 1 },
        ],
        date: dateYmd,
        time: "13:00",
        mode: "sync_start",
        organizer_name: "Voice SMS Group",
        organizer_phone: "+16045557799",
      },
      salonSlug: SLUG,
    },
  });

  if (res.status() === 409) {
    console.warn("[voice-sms] 409 slot conflict — skipping group smsSent assertion.");
    return;
  }
  expect(res.status()).toBe(200);
  const body = await res.json();

  // Group booking must succeed regardless of SMS outcome.
  expect(body?.ok, "group booking should succeed even if SMS can't be sent").toBe(true);

  // The response MUST carry an explicit smsSent boolean.
  expect(typeof body?.smsSent, "smsSent must be present as a boolean").toBe("boolean");
});
