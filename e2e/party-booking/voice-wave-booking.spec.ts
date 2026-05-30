/**
 * Phase 6 — Voice AI Wave Booking E2E (API + public Party Link page).
 *
 * A dedicated 3-staff salon makes a 5-person group exceed simultaneous capacity,
 * so the scheduler must offer a 2-wave split instead of "no availability".
 *
 * Covers:
 *   - get_group_available_slots returns a wave option (isWaveOption + waves)
 *   - confirm_group_booking creates bookings with correct wave_number + Party Link
 *   - Party Link page groups slots into Wave 1 / Wave 2 sections
 *   - sync_finish large group returns the "arrive together" message
 *
 * Run: npm run test:e2e -- e2e/party-booking/voice-wave-booking.spec.ts
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

const SLUG = "e2e-wave";
let salon: PartyTestSalon;

test.beforeAll(async () => {
  // seedPartyTestSalon → 3 staff + 3 services (every staff capable of every service).
  salon = await seedPartyTestSalon(SLUG);
});

test.afterAll(async () => {
  await cleanupPartyTestSalon(SLUG, salon?.salonId);
});

/** 5 people across 2 services — exceeds the salon's 3 staff. */
function fivePeople(serviceIds: string[]) {
  return [
    { service_id: serviceIds[0], count: 3 },
    { service_id: serviceIds[1] ?? serviceIds[0], count: 2 },
  ];
}

// ─── get_group_available_slots offers a wave option ────────────────

test("get_group_available_slots returns a wave option when group exceeds capacity", async ({
  request,
  baseURL,
}) => {
  const res = await request.post(`${baseURL}/api/voice/tool`, {
    data: {
      toolName: "get_group_available_slots",
      toolArgs: {
        service_assignments: fivePeople(salon.serviceIds),
        date: nextOpenDateYmd(2),
        target_time: "10:00",
        mode: "sync_start",
      },
      salonSlug: SLUG,
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();

  expect(body?.isWaveOption, "5 people / 3 staff should yield a wave option").toBe(true);
  const arr = body?.arrangements?.[0];
  expect(arr?.isWaveBooking).toBe(true);
  expect(arr?.waveCount).toBe(2);
  expect(Array.isArray(arr?.waves)).toBe(true);
  expect(arr.waves.length).toBe(2);
  // Wave 1 seats 3 (capacity), wave 2 seats the remaining 2.
  expect(arr.waves.map((w: { memberCount: number }) => w.memberCount)).toEqual([3, 2]);
  expect(String(arr?.summary)).toMatch(/wave/i);
});

// ─── confirm_group_booking persists wave_number + Party Link ───────

test("confirm_group_booking saves correct wave_number and covers all waves in the Party Link", async ({
  request,
  baseURL,
}) => {
  const res = await request.post(`${baseURL}/api/voice/tool`, {
    data: {
      toolName: "confirm_group_booking",
      toolArgs: {
        service_assignments: fivePeople(salon.serviceIds),
        date: nextOpenDateYmd(3),
        time: "10:00",
        mode: "sync_start",
        organizer_name: "Wave Organizer",
        organizer_phone: "+16045552200",
      },
      salonSlug: SLUG,
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();

  expect(body?.ok).toBe(true);
  expect(body?.isWaveBooking).toBe(true);
  expect(body?.waveCount).toBe(2);

  const groupId: string = body.groupId ?? body.group_id;
  expect(groupId).toBeTruthy();

  // DB: 5 booking rows, wave_number split 3 (wave 1) + 2 (wave 2).
  const { data: rows } = await supabase
    .from("bookings")
    .select("client_name, wave_number, start_time_utc")
    .eq("group_id", groupId)
    .order("wave_number");
  expect(rows?.length).toBe(5);

  const wave1 = (rows ?? []).filter((r) => r.wave_number === 1);
  const wave2 = (rows ?? []).filter((r) => r.wave_number === 2);
  expect(wave1.length).toBe(3);
  expect(wave2.length).toBe(2);

  // Wave 2 starts strictly after wave 1 (later start_time_utc).
  const w1Start = Math.max(...wave1.map((r) => Date.parse(r.start_time_utc as string)));
  const w2Start = Math.min(...wave2.map((r) => Date.parse(r.start_time_utc as string)));
  expect(w2Start).toBeGreaterThan(w1Start);

  // All rows still carry Guest N placeholders (never the organizer name).
  for (const r of rows ?? []) {
    expect(String(r.client_name)).toMatch(/^Guest \d+$/);
  }

  // Party Link exists for the whole group.
  await expect
    .poll(async () => {
      const { data } = await supabase
        .from("party_links")
        .select("token")
        .eq("group_id", groupId)
        .maybeSingle();
      return data?.token ?? null;
    }, { timeout: 10_000, intervals: [500] })
    .not.toBeNull();
});

// ─── Party Link page renders Wave 1 / Wave 2 sections ──────────────

test("Party Link page groups slots into wave sections", async ({ request, baseURL, page }) => {
  const res = await request.post(`${baseURL}/api/voice/tool`, {
    data: {
      toolName: "confirm_group_booking",
      toolArgs: {
        service_assignments: fivePeople(salon.serviceIds),
        date: nextOpenDateYmd(4),
        time: "10:00",
        mode: "sync_start",
        organizer_name: "Wave Page",
        organizer_phone: "+16045552201",
      },
      salonSlug: SLUG,
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const partyLinkUrl: string | null = body?.partyLinkUrl ?? null;
  test.skip(!partyLinkUrl, "no party link returned");

  await page.goto(partyLinkUrl!);
  await expect(page.getByTestId("party-wave-1")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("party-wave-2")).toBeVisible();

  // Organizer phone must never appear on the public page.
  const html = await page.content();
  expect(html.includes("16045552201")).toBe(false);
});

// ─── sync_finish large group: graceful "arrive together" message ───

test("sync_finish large group returns the unsupported/arrive-together message", async ({
  request,
  baseURL,
}) => {
  const res = await request.post(`${baseURL}/api/voice/tool`, {
    data: {
      toolName: "get_group_available_slots",
      toolArgs: {
        service_assignments: fivePeople(salon.serviceIds),
        date: nextOpenDateYmd(5),
        target_time: "12:00",
        mode: "sync_finish",
      },
      salonSlug: SLUG,
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  // No simultaneous finish-together arrangement for a group bigger than capacity.
  expect(String(body?.message ?? "")).toMatch(/finish together is not available/i);
});
