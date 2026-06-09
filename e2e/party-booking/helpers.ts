/**
 * Party Booking E2E shared helpers.
 *
 * Extends the group-booking seed with party_links + party_link_claims
 * so tests can verify the full Party Booking system without re-running
 * the 5-step web flow in every spec.
 */
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import { seedGroupTestSalon, type GroupTestSalon } from "../group-booking/helpers";
import { cleanupTestSalon } from "../helpers/db";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl?.trim() || !serviceKey?.trim()) {
  throw new Error(
    "e2e/party-booking/helpers requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
  );
}
const supabase = createClient(supabaseUrl, serviceKey);

export type PartyTestSalon = GroupTestSalon;

// ─── Salon seed ───────────────────────────────────────────────────

export async function seedPartyTestSalon(slug: string): Promise<PartyTestSalon> {
  return seedGroupTestSalon(slug);
}

// ─── Party Link seed ──────────────────────────────────────────────

export type SeedPartyLinkOpts = {
  salonId: string;
  staffIds: string[];
  serviceIds: string[];
  mode?: "sync_start" | "sync_finish";
  /** Number of booking slots to create (≥2). Default 2. */
  slotCount?: number;
  /** Hours from now until the group starts. Default 3. */
  hoursFromNow?: number;
  /** Phase 6: wave_number per slot index (e.g. [1,1,1,2,2]). Defaults to all 1. */
  wavePlan?: number[];
  /**
   * If set, pre-claims the first slot in the DB so tests that need a
   * claimed slot don't have to run through the UI claim flow.
   */
  preClaimedName?: string;
};

export type SeededPartyLink = {
  partyLinkId: string;
  token: string;
  groupId: string;
  bookingIds: string[];
  claimIds: string[];
};

/**
 * Directly inserts a group booking + party link + claims into the DB.
 * Bypasses the web flow — useful when testing the party link page or
 * dashboard party card without going through all 5 booking steps.
 */
export async function seedPartyLink(opts: SeedPartyLinkOpts): Promise<SeededPartyLink> {
  const {
    salonId,
    staffIds,
    serviceIds,
    mode = "sync_start",
    slotCount = 2,
    hoursFromNow = 3,
    wavePlan,
  } = opts;

  const groupId = crypto.randomUUID();
  const startMs = Date.now() + hoursFromNow * 3600_000;
  const bookingIds: string[] = [];

  // Insert one booking per slot. Without a wavePlan, stagger by 5 min (legacy).
  // With a wavePlan, lay each wave out in its own 60-min block and assign distinct
  // staff WITHIN a wave, so the bookings_no_overlap exclusion constraint holds.
  const perWaveCount = new Map<number, number>();
  for (let i = 0; i < slotCount; i++) {
    const wave = wavePlan?.[i] ?? 1;
    let slotStartMs: number;
    let staffId: string;
    if (wavePlan) {
      const posInWave = perWaveCount.get(wave) ?? 0;
      perWaveCount.set(wave, posInWave + 1);
      slotStartMs = startMs + (wave - 1) * 60 * 60_000; // 45-min service + 15-min buffer
      staffId = staffIds[posInWave % staffIds.length];
    } else {
      slotStartMs = startMs + i * 5 * 60_000;
      staffId = staffIds[i % staffIds.length];
    }
    const slotStart = new Date(slotStartMs).toISOString();
    const slotEnd = new Date(slotStartMs + 45 * 60_000).toISOString();

    const { data: booking, error: bErr } = await supabase
      .from("bookings")
      .insert({
        salon_id: salonId,
        group_id: groupId,
        staff_id: staffId,
        service_id: serviceIds[i % serviceIds.length],
        client_name: `Guest ${i + 1}`,
        client_phone: `1555000000${i}`,
        wave_number: wave,
        start_time_utc: slotStart,
        end_time_utc: slotEnd,
        status: "confirmed",
        price_cents: 3000 + i * 500,
        source: "appointment",
        idempotency_key: crypto.randomUUID(),
      })
      .select("id")
      .single();

    if (bErr || !booking?.id) throw new Error(`seedPartyLink booking[${i}]: ${bErr?.message}`);
    bookingIds.push(String(booking.id));
  }

  // Insert the party link (24h TTL from start).
  const token = crypto.randomBytes(8).toString("hex");
  const expiresAt = new Date(startMs + 24 * 3600_000).toISOString();

  const { data: link, error: lErr } = await supabase
    .from("party_links")
    .insert({ group_id: groupId, salon_id: salonId, token, mode, expires_at: expiresAt })
    .select("id")
    .single();

  if (lErr || !link?.id) throw new Error(`seedPartyLink party_links: ${lErr?.message}`);
  const partyLinkId = String(link.id);

  // Pre-create one claim per booking.
  const claimRows = bookingIds.map((bid) => ({
    party_link_id: partyLinkId,
    booking_id: bid,
  }));
  const { data: claims, error: cErr } = await supabase
    .from("party_link_claims")
    .insert(claimRows)
    .select("id");

  if (cErr || !claims) throw new Error(`seedPartyLink party_link_claims: ${cErr?.message}`);
  const claimIds = claims.map((c) => String(c.id));

  // Optionally pre-claim the first slot so UI tests start with a claimed slot.
  if (opts.preClaimedName) {
    await supabase
      .from("party_link_claims")
      .update({
        member_name: opts.preClaimedName,
        member_phone: "16045550099",
        claimed_at: new Date().toISOString(),
      })
      .eq("id", claimIds[0]);
    // Mirror claim to bookings.client_name (matches claim_party_slot RPC behavior).
    await supabase
      .from("bookings")
      .update({ client_name: opts.preClaimedName })
      .eq("id", bookingIds[0]);
  }

  return { partyLinkId, token, groupId, bookingIds, claimIds };
}

// ─── DB queries ───────────────────────────────────────────────────

export async function getPartyLinkToken(groupId: string): Promise<string | null> {
  const { data } = await supabase
    .from("party_links")
    .select("token")
    .eq("group_id", groupId)
    .maybeSingle();
  return data?.token ?? null;
}

/** Status of every booking in a group — used to assert a whole-group cancel. */
export async function getGroupBookingStatuses(
  salonId: string,
  groupId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("bookings")
    .select("status")
    .eq("salon_id", salonId)
    .eq("group_id", groupId);
  return (data ?? []).map((r) => String(r.status));
}

export async function getPartyClaims(partyLinkId: string) {
  const { data } = await supabase
    .from("party_link_claims")
    .select("id, booking_id, member_name, claimed_at")
    .eq("party_link_id", partyLinkId);
  return data ?? [];
}

export async function getChangeRequests(partyLinkId: string) {
  const { data } = await supabase
    .from("party_link_change_requests")
    .select("id, status, request_type, note")
    .eq("party_link_id", partyLinkId);
  return data ?? [];
}

// ─── Cleanup ──────────────────────────────────────────────────────

/**
 * Delete party_links + claims for a salon before calling cleanupTestSalon.
 * Required because party_link_claims has a FK on bookings — must delete
 * claims before bookings or the cascade order causes FK violations.
 */
export async function cleanupPartyData(salonId: string) {
  const { data: links } = await supabase
    .from("party_links")
    .select("id")
    .eq("salon_id", salonId);

  const linkIds = (links ?? []).map((l) => String(l.id));
  if (linkIds.length > 0) {
    await supabase.from("party_link_change_requests").delete().in("party_link_id", linkIds);
    await supabase.from("party_link_claims").delete().in("party_link_id", linkIds);
    await supabase.from("party_links").delete().in("id", linkIds);
  }
}

export async function cleanupPartyTestSalon(slug: string, salonId?: string) {
  if (salonId) await cleanupPartyData(salonId);
  await cleanupTestSalon(slug);
}

// ─── Page helpers ─────────────────────────────────────────────────

export async function gotoPartyLinkPage(page: Page, token: string): Promise<void> {
  await page.goto(`/party/${token}`);
  // Wait for either slot cards or the expired/not-found message.
  await page
    .locator('[data-testid^="party-slot-card-"], [data-testid="party-expired"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  // Wait for React hydration to complete so buttons are interactive.
  await page.waitForLoadState("networkidle");
}

/**
 * Navigate to the receptionist center dashboard with the demo cookie.
 * Mirrors gotoReceptionistCenter from the receptionist-center helpers.
 */
export async function gotoPartyDashboard(
  page: Page,
  slug: string,
  baseURL?: string,
): Promise<void> {
  const url = baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  await page.context().addCookies([
    { name: "nailiq-demo-slug", value: slug, url },
  ]);
  await page.addInitScript(() => {
    window.localStorage.setItem("nailiq-user-lang", "en");
  });
  await page.goto(`/dashboard/${slug}/center`);
  await page
    .getByTestId("receptionist-center-loaded")
    .waitFor({ state: "visible", timeout: 20_000 });

  // The party-card panel now lives inside the AttentionChipBar "Groups"
  // dropdown (non-basic modes). Open it so callers can reach the panel.
  // Conditional: a no-op when no active party / no chip is present.
  const groupsChip = page.getByTestId("attention-chip-groups");
  if (await groupsChip.count()) {
    await groupsChip.click();
    await page
      .getByTestId("party-card-panel")
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => {});
  }
}
