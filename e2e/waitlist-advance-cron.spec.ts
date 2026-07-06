/**
 * Waitlist advance cron — /api/cron/waitlist-advance + notifyWaitlistForSlot.
 *
 * Regression guards for PR #703:
 *  1. RPC `advance_waitlist_notifications` must not throw when it has work to do
 *     (it used to hit Postgres 42702 "column reference salon_id is ambiguous"
 *     the moment an expired 'notified' entry entered its loop body → cron 500).
 *  2. The notify picker must target the entry the DB just promoted for the RIGHT
 *     date — not re-message an already-notified customer who is still in-window
 *     for a DIFFERENT date. The pre-fix SELECT ignored booking_date and ordered
 *     notified_at ASC, so it grabbed the older entry.
 */
import { test, expect } from "@playwright/test";
import { cleanupTestSalon, seedTestSalon } from "./helpers/db";
import { createServiceRoleClient } from "../src/shared/lib/supabase/serviceRole";
// NOTE: notifyWaitlistForSlot can't be imported here — its module graph pulls
// `import "server-only"`, which throws outside the Next server bundle. Its
// picker is a plain Supabase SELECT, so the second test mirrors that exact
// query (incl. a control proving the OLD, date-blind form picks the wrong row).

const ymd = (d: Date) => d.toISOString().split("T")[0];

// Distinct 555-exchange numbers (fictional NANP → never billed / never a real
// customer even if a suppression guard were to miss).
const PHONE_D1_NOTIFIED = "16045551201"; // already notified for D1, in-window
const PHONE_D2_EXPIRED = "16045551202"; // notified for D2 but window elapsed
const PHONE_D2_PROMOTED = "16045551203"; // next-in-line for D2 → should win

type SeedRow = { client_phone: string; status: string; claim_token: string | null };

test.describe("Waitlist advance cron", () => {
  let testSlug: string;
  let salonId: string;
  let serviceId: string;
  let d1Ymd: string;
  let d2Ymd: string;
  let d1EntryId: string;
  let d2PromotedEntryId: string;

  test.beforeEach(async () => {
    const { slug, salonId: id } = await seedTestSalon({
      slug: "e2e-waitlist-cron-advance",
      name: "E2E Waitlist Cron Salon",
      phone: "16045551200",
    });
    testSlug = slug;
    salonId = id;

    const supabase = createServiceRoleClient();
    const { data: svc } = await supabase
      .from("services").select("id").eq("salon_id", salonId).limit(1).maybeSingle();
    serviceId = (svc as unknown as { id: string }).id;

    const now = Date.now();
    d1Ymd = ymd(new Date(now + 24 * 60 * 60 * 1000)); // tomorrow
    d2Ymd = ymd(new Date(now + 48 * 60 * 60 * 1000)); // day after

    const base = { salon_id: salonId, service_id: serviceId, source: "slot_unavailable" };

    const { data: inserted } = await supabase
      .from("booking_waitlist_entries" as never)
      .insert([
        // A — date D1, freshly notified 5 min ago (still in its 20-min window).
        // Older notified_at than any D2 promotion → the exact row the buggy
        // ASC-ordered, date-blind picker latched onto.
        {
          ...base,
          booking_date: d1Ymd,
          client_name: "D1 Already Notified",
          client_phone: PHONE_D1_NOTIFIED,
          status: "notified",
          claim_token: "11111111-1111-1111-1111-111111111111",
          claimed_at: null,
          notified_at: new Date(now - 5 * 60 * 1000).toISOString(),
        },
        // B — date D2, notified 30 min ago → EXPIRED → cron flips to 'expired'
        // and promotes the next D2 waiter (C).
        {
          ...base,
          booking_date: d2Ymd,
          client_name: "D2 Expired",
          client_phone: PHONE_D2_EXPIRED,
          status: "notified",
          claim_token: "22222222-2222-2222-2222-222222222222",
          claimed_at: null,
          notified_at: new Date(now - 30 * 60 * 1000).toISOString(),
        },
        // C — date D2, waiting → the one that should be promoted + notified.
        {
          ...base,
          booking_date: d2Ymd,
          client_name: "D2 Promoted",
          client_phone: PHONE_D2_PROMOTED,
          status: "waiting",
        },
      ])
      .select("id, client_phone");

    const rows = (inserted ?? []) as Array<{ id: string; client_phone: string }>;
    d1EntryId = rows.find((r) => r.client_phone === PHONE_D1_NOTIFIED)!.id;
    d2PromotedEntryId = rows.find((r) => r.client_phone === PHONE_D2_PROMOTED)!.id;
  });

  test.afterEach(async () => {
    await cleanupTestSalon(testSlug);
  });

  test("cron advance promotes the next D2 waiter without touching the in-window D1 entry", async ({
    page,
  }) => {
    // Auth: the test runner and the dev server both load .env.local, so a set
    // CRON_SECRET matches on both sides; when unset (CI) the route passes with
    // no header (undefined === undefined).
    const secret = process.env.CRON_SECRET;
    const res = await page.request.get("/api/cron/waitlist-advance", {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
    // Pre-fix this 500'd with {"error":"rpc_failed"} (Postgres 42702).
    expect(res.ok(), `cron responded ${res.status()}: ${await res.text()}`).toBe(true);
    const body = (await res.json()) as { ok?: boolean; advanced?: number };
    expect(body.ok).toBe(true);
    expect(body.advanced).toBeGreaterThanOrEqual(1);

    const supabase = createServiceRoleClient();
    const { data: entries } = await supabase
      .from("booking_waitlist_entries" as never)
      .select("client_phone, status, claim_token")
      .eq("salon_id", salonId);
    const byPhone = Object.fromEntries(
      (entries as SeedRow[]).map((e) => [e.client_phone, e]),
    );

    // Expired D2 link retired; next D2 waiter promoted with a fresh token.
    expect(byPhone[PHONE_D2_EXPIRED].status).toBe("expired");
    expect(byPhone[PHONE_D2_PROMOTED].status).toBe("notified");
    expect(byPhone[PHONE_D2_PROMOTED].claim_token).not.toBeNull();
    // The in-window D1 entry is left exactly as it was.
    expect(byPhone[PHONE_D1_NOTIFIED].status).toBe("notified");
  });

  test("notify picker selects the just-promoted D2 entry, not the older in-window D1 entry", async () => {
    const supabase = createServiceRoleClient();

    // Promote the D2 waiter exactly as the cron's RPC does. Now BOTH A (D1,
    // notified 5 min ago) and C (D2, notified just now) are 'notified'.
    const { error: rpcError } = await supabase.rpc("advance_waitlist_notifications", {
      p_window_minutes: 20,
    });
    expect(rpcError, JSON.stringify(rpcError)).toBeNull();

    // Common lead-in mirroring notifyWaitlistForSlot's SELECT.
    const pickerBase = () =>
      supabase
        .from("booking_waitlist_entries" as never)
        .select("id, client_phone, notified_at")
        .eq("salon_id", salonId)
        .eq("service_id", serviceId)
        .eq("status", "notified")
        .not("claim_token", "is", null);

    // CONTROL — the PRE-FIX picker (no booking_date filter, notified_at ASC)
    // grabs the older D1 entry: the bug. This proves the scenario genuinely
    // distinguishes the two implementations.
    const { data: buggy } = await pickerBase()
      .order("notified_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    expect((buggy as { id: string }).id).toBe(d1EntryId);

    // FIXED — scoped to D2 + newest-first → the just-promoted C.
    const { data: fixed } = await pickerBase()
      .eq("booking_date", d2Ymd)
      .order("notified_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    expect((fixed as { id: string; client_phone: string }).id).toBe(d2PromotedEntryId);
    expect((fixed as { client_phone: string }).client_phone).toBe(PHONE_D2_PROMOTED);
  });
});
