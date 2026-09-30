/**
 * Waitlist advance cron — /api/cron/waitlist-advance.
 *
 * Regression guards for PR #703:
 *  1. RPC `advance_waitlist_notifications` must not throw when it has work to do
 *     (it used to hit Postgres 42702 "column reference salon_id is ambiguous"
 *     the moment an expired 'notified' entry entered its loop body → cron 500).
 *  2. The notify picker must message the entry the DB just promoted for the
 *     RIGHT date — not re-message an already-notified customer still in-window
 *     for a DIFFERENT date. The pre-fix SELECT ignored booking_date and ordered
 *     notified_at ASC, so it grabbed the older entry.
 *
 * Both are observed end-to-end by driving the real cron endpoint: (1) via the
 * entry-status transitions and (2) via the waitlist_invite row the notify path
 * writes to booking_notifications. (2) relies on suppressed sends carrying a
 * UNIQUE fake SID — see the stacked fix in twilioSms.ts; without it the log
 * insert collides on the twilio_message_sid unique index and is swallowed.
 */
import { test, expect } from "@playwright/test";
import { cleanupTestSalon, seedTestSalon } from "./helpers/db";
import { createServiceRoleClient } from "../src/shared/lib/supabase/serviceRole";

const ymd = (d: Date) => d.toISOString().split("T")[0];

// Distinct 555-exchange numbers (fictional NANP → never billed / never a real
// customer even if a suppression guard were to miss).
const PHONE_D1_NOTIFIED = "16045551201"; // already notified for D1, in-window
const PHONE_D2_EXPIRED = "16045551202"; // notified for D2 but window elapsed
const PHONE_D2_PROMOTED = "16045551203"; // next-in-line for D2 → should win

type StateRow = { client_phone: string; status: string; claim_token: string | null };

test.describe("Waitlist advance cron", () => {
  let testSlug: string;
  let salonId: string;
  let serviceId: string;
  let d1Ymd: string;
  let d2Ymd: string;

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

    await supabase.from("booking_waitlist_entries" as never).insert([
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
    ]);
  });

  test.afterEach(async () => {
    await cleanupTestSalon(testSlug);
  });

  // Auth: the test runner and the dev server both load .env.local, so a set
  // CRON_SECRET matches on both sides; when unset (CI) the route passes with no
  // header (undefined === undefined).
  async function runCron(request: import("@playwright/test").APIRequestContext) {
    const secret = process.env.CRON_SECRET;
    const res = await request.get("/api/cron/waitlist-advance", {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
    // Pre-fix this 500'd with {"error":"rpc_failed"} (Postgres 42702).
    expect(res.ok(), `cron responded ${res.status()}: ${await res.text()}`).toBe(true);
    return (await res.json()) as { ok?: boolean; advanced?: number };
  }

  test("cron advance promotes the next D2 waiter without touching the in-window D1 entry", async ({
    request,
  }) => {
    const body = await runCron(request);
    expect(body.ok).toBe(true);
    expect(body.advanced).toBeGreaterThanOrEqual(1);

    const supabase = createServiceRoleClient();
    const { data: entries } = await supabase
      .from("booking_waitlist_entries" as never)
      .select("client_phone, status, claim_token")
      .eq("salon_id", salonId);
    const byPhone = Object.fromEntries(
      (entries as StateRow[]).map((e) => [e.client_phone, e]),
    );

    // Expired D2 link retired; next D2 waiter promoted with a fresh token.
    expect(byPhone[PHONE_D2_EXPIRED].status).toBe("expired");
    expect(byPhone[PHONE_D2_PROMOTED].status).toBe("notified");
    expect(byPhone[PHONE_D2_PROMOTED].claim_token).not.toBeNull();
    // The in-window D1 entry is left exactly as it was.
    expect(byPhone[PHONE_D1_NOTIFIED].status).toBe("notified");
  });

  test("cron messages the just-promoted D2 customer, not the older in-window D1 one", async ({
    request,
  }) => {
    test.skip(
      process.env.DISABLE_OUTBOUND_SMS === "1",
      "Remote QA deliberately disables outbound SMS; promotion state is covered above.",
    );
    await runCron(request);

    const supabase = createServiceRoleClient();
    const { data: notes } = await supabase
      .from("booking_notifications" as never)
      .select("client_phone, body_preview")
      .eq("salon_id", salonId)
      .eq("notification_type", "waitlist_invite")
      .eq("channel", "sms");
    const rows = (notes ?? []) as Array<{ client_phone: string; body_preview: string | null }>;
    const recipients = rows.map((r) => r.client_phone);

    // The promoted D2 customer got the claim SMS…
    expect(recipients).toContain(PHONE_D2_PROMOTED);
    // …and the already-notified, still-in-window D1 customer was NOT re-messaged
    // (the core regression: pre-fix this re-SMS'd D1 with the wrong date).
    expect(recipients).not.toContain(PHONE_D1_NOTIFIED);

    // The SMS body names the D2 date, not D1.
    const promoted = rows.find((r) => r.client_phone === PHONE_D2_PROMOTED);
    expect(promoted?.body_preview).toContain(d2Ymd);
    expect(promoted?.body_preview).not.toContain(d1Ymd);
  });
});
