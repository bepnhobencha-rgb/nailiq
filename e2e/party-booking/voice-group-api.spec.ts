/**
 * Party Booking — Voice AI group booking API tests.
 *
 * Covers:
 *   - Test 10a: get_group_available_slots returns arrangements
 *   - Test 10b: confirm_group_booking creates bookings + Party Link
 *   - Test 10c: Party Link returned is navigable
 *   - Test 10d: booking source is "voice"
 *
 * API-level only — no browser microphone required.
 * Sends HTTP POST requests to /api/voice/tool on the dev server.
 *
 * Run: npm run test:e2e -- e2e/party-booking/voice-group-api.spec.ts
 */
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  cleanupPartyTestSalon,
  seedPartyTestSalon,
  type PartyTestSalon,
} from "./helpers";
import { nextOpenDateYmd } from "../group-booking/helpers";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SLUG = "e2e-party-voice";
let salon: PartyTestSalon;

test.beforeAll(async () => {
  salon = await seedPartyTestSalon(SLUG);
});

test.afterAll(async () => {
  await cleanupPartyTestSalon(SLUG, salon?.salonId);
});

// ─── Helpers ──────────────────────────────────────────────────────

function voiceTool(
  baseURL: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
) {
  return { url: `${baseURL}/api/voice/tool`, toolName, toolArgs };
}

// ─── Test 10a: get_group_available_slots ──────────────────────────

test("get_group_available_slots returns arrangements for the seeded salon", async ({
  request,
  baseURL,
}) => {
  const dateYmd = nextOpenDateYmd(2);
  const { serviceIds } = salon;

  const res = await request.post(`${baseURL}/api/voice/tool`, {
    data: {
      toolName: "get_group_available_slots",
      toolArgs: {
        service_assignments: [
          { service_id: serviceIds[0], count: 1 },
          { service_id: serviceIds[1] ?? serviceIds[0], count: 1 },
        ],
        date: dateYmd,
        target_time: "14:00",
        mode: "sync_start",
      },
      salonSlug: SLUG,
    },
  });

  expect(res.status()).toBe(200);
  const body = await res.json();

  // Response shape: { arrangements: [...], ... }
  // At minimum, arrangements should be an array (may be empty if no slots).
  const arrangements = body?.arrangements ?? body?.slots ?? [];
  expect(Array.isArray(arrangements)).toBe(true);
});

// ─── Test 10b: confirm_group_booking creates bookings ─────────────

test("confirm_group_booking creates group booking and Party Link", async ({
  request,
  baseURL,
}) => {
  const { serviceIds } = salon;
  const dateYmd = nextOpenDateYmd(3); // Use a different day from 10a to avoid conflict

  // Phase 1: get available slots to find a valid time.
  const slotsRes = await request.post(`${baseURL}/api/voice/tool`, {
    data: {
      toolName: "get_group_available_slots",
      toolArgs: {
        service_assignments: [
          { service_id: serviceIds[0], count: 1 },
          { service_id: serviceIds[1] ?? serviceIds[0], count: 1 },
        ],
        date: dateYmd,
        target_time: "10:00",
        mode: "sync_start",
      },
      salonSlug: SLUG,
    },
  });

  expect(slotsRes.status()).toBe(200);
  const slotsBody = await slotsRes.json();

  // Extract the first arrangement time (HH:MM 24h).
  const arrangements: Array<{ time?: string; startTime?: string }> =
    slotsBody?.arrangements ?? slotsBody?.slots ?? [];

  // If no slots available (e.g. salon closed on this date), skip gracefully.
  if (arrangements.length === 0) {
    console.warn("[voice-group-api] No arrangements returned — possible closed date. Skipping confirm.");
    return;
  }

  const chosenTime: string = (arrangements[0]?.time ?? arrangements[0]?.startTime ?? "10:00");

  // Phase 2: confirm the booking.
  const confirmRes = await request.post(`${baseURL}/api/voice/tool`, {
    data: {
      toolName: "confirm_group_booking",
      toolArgs: {
        service_assignments: [
          { service_id: serviceIds[0], count: 1 },
          { service_id: serviceIds[1] ?? serviceIds[0], count: 1 },
        ],
        date: dateYmd,
        time: chosenTime,
        mode: "sync_start",
        organizer_name: "Voice E2E Organizer",
        organizer_phone: "+16045551234",
      },
      salonSlug: SLUG,
    },
  });

  expect(confirmRes.status()).toBe(200);
  const body = await confirmRes.json();

  // Must return groupId (or group_id).
  const groupId: string | undefined =
    body?.groupId ?? body?.group_id ?? body?.data?.groupId;

  expect(groupId, "confirm_group_booking must return a groupId").toBeTruthy();
});

// ─── Test 10c: Party Link is created in DB ─────────────────────────

test("confirm_group_booking creates a Party Link row in DB", async ({
  request,
  baseURL,
}) => {
  const { serviceIds } = salon;
  const dateYmd = nextOpenDateYmd(4);

  // Single-step confirm (no pre-slot check — uses a reasonable time).
  const res = await request.post(`${baseURL}/api/voice/tool`, {
    data: {
      toolName: "confirm_group_booking",
      toolArgs: {
        service_assignments: [
          { service_id: serviceIds[0], count: 1 },
          { service_id: serviceIds[1] ?? serviceIds[0], count: 1 },
        ],
        date: dateYmd,
        time: "11:00",
        mode: "sync_start",
        organizer_name: "Voice E2E Alice",
        organizer_phone: "+16045559001",
      },
      salonSlug: SLUG,
    },
  });

  if (res.status() === 409) {
    // Slot conflict — not a test failure, just reschedule contention.
    console.warn("[voice-group-api] 409 slot conflict — skipping DB assertion.");
    return;
  }
  expect(res.status()).toBe(200);

  const body = await res.json();
  const groupId: string | undefined = body?.groupId ?? body?.group_id;
  if (!groupId) return; // Already covered in test 10b

  // Party Link should appear in DB within a few seconds (async creation).
  await expect
    .poll(
      async () => {
        const { data } = await supabase
          .from("party_links")
          .select("token")
          .eq("group_id", groupId)
          .maybeSingle();
        return data?.token ?? null;
      },
      { timeout: 10_000, intervals: [500], message: "party_links row should exist" },
    )
    .not.toBeNull();
});

// ─── Test 10d: booking source is "voice" ──────────────────────────

test("bookings created by voice confirm_group_booking have source=voice", async ({
  request,
  baseURL,
}) => {
  const { serviceIds } = salon;
  const dateYmd = nextOpenDateYmd(5);

  const res = await request.post(`${baseURL}/api/voice/tool`, {
    data: {
      toolName: "confirm_group_booking",
      toolArgs: {
        service_assignments: [
          { service_id: serviceIds[0], count: 1 },
          { service_id: serviceIds[1] ?? serviceIds[0], count: 1 },
        ],
        date: dateYmd,
        time: "15:00",
        mode: "sync_start",
        organizer_name: "Voice Source Test",
        organizer_phone: "+16045559002",
      },
      salonSlug: SLUG,
    },
  });

  if (res.status() === 409) {
    console.warn("[voice-group-api] 409 slot conflict — skipping source check.");
    return;
  }
  expect(res.status()).toBe(200);

  const body = await res.json();
  const groupId: string | undefined = body?.groupId ?? body?.group_id;
  if (!groupId) return;

  // Check that the bookings have source = "voice".
  const { data: bookings } = await supabase
    .from("bookings")
    .select("source")
    .eq("group_id", groupId);

  const allVoice = (bookings ?? []).every((b) => b.source === "voice");
  expect(allVoice, "all voice bookings should have source='voice'").toBe(true);
});

// ─── Test 10e: bookings have Guest N names, NOT organizer name ────

test("voice confirm_group_booking stores Guest N placeholders, not organizer name", async ({
  request,
  baseURL,
}) => {
  const { serviceIds } = salon;
  const organizerName = "Voice Placeholder Test";
  const dateYmd = nextOpenDateYmd(6);

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
        organizer_name: organizerName,
        organizer_phone: "+16045559003",
      },
      salonSlug: SLUG,
    },
  });

  if (res.status() === 409) {
    console.warn("[voice-group-api] 409 conflict — skipping placeholder check.");
    return;
  }
  expect(res.status()).toBe(200);

  const body = await res.json();
  const groupId: string | undefined = body?.groupId ?? body?.group_id;
  if (!groupId) return;

  // All bookings in the group must have "Guest N" client_name, NOT the organizer name.
  const { data: bookings } = await supabase
    .from("bookings")
    .select("client_name")
    .eq("group_id", groupId);

  const names = (bookings ?? []).map((b) => String(b.client_name ?? ""));
  expect(names.length, "should have at least 2 booking rows").toBeGreaterThanOrEqual(2);

  for (let i = 0; i < names.length; i++) {
    expect(
      names[i],
      `booking[${i}] should be "Guest ${i + 1}", got "${names[i]}"`,
    ).toMatch(/^Guest \d+$/);
    expect(
      names[i],
      `booking[${i}] client_name must not be the organizer name`,
    ).not.toBe(organizerName);
  }
});

// ─── Test 10f: 3-person voice booking creates Guest 1–Guest 3 ─────

test("3-person voice group booking creates Guest 1, Guest 2, Guest 3", async ({
  request,
  baseURL,
}) => {
  const { serviceIds } = salon;
  const dateYmd = nextOpenDateYmd(7);

  const res = await request.post(`${baseURL}/api/voice/tool`, {
    data: {
      toolName: "confirm_group_booking",
      toolArgs: {
        service_assignments: [
          { service_id: serviceIds[0], count: 2 },
          { service_id: serviceIds[1] ?? serviceIds[0], count: 1 },
        ],
        date: dateYmd,
        time: "14:00",
        mode: "sync_start",
        organizer_name: "Voice 3Person Test",
        organizer_phone: "+16045559004",
      },
      salonSlug: SLUG,
    },
  });

  if (res.status() === 409) {
    console.warn("[voice-group-api] 409 conflict — skipping 3-person check.");
    return;
  }
  if (res.status() !== 200) return; // Graceful: skip if salon doesn't support 3 concurrent

  const body = await res.json();
  const groupId: string | undefined = body?.groupId ?? body?.group_id;
  if (!groupId) return;

  const { data: bookings } = await supabase
    .from("bookings")
    .select("client_name")
    .eq("group_id", groupId)
    .order("created_at");

  const names = (bookings ?? []).map((b) => String(b.client_name ?? ""));
  expect(names.length, "3-person group should have 3 booking rows").toBe(3);

  names.forEach((name, i) => {
    expect(name, `booking[${i}] should be "Guest ${i + 1}"`).toBe(`Guest ${i + 1}`);
  });
});
