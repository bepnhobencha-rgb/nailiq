/**
 * Waitlist advance cron — /api/cron/waitlist-advance.
 *
 * Regression guard for the "notified the wrong customer" bug (PR #703):
 * when a salon holds several concurrently 'notified' entries for the SAME
 * service across DIFFERENT dates, promoting the next-in-line for date D2 must
 * notify that promoted person — NOT re-SMS an already-notified customer who is
 * still in-window for date D1. The pre-fix picker ignored booking_date and
 * ordered notified_at ASC, so it grabbed the older D1 entry.
 */
import { test, expect } from "@playwright/test";
import { cleanupTestSalon, seedTestSalon } from "./helpers/db";
import { createServiceRoleClient } from "../src/shared/lib/supabase/serviceRole";

const ymd = (d: Date) => d.toISOString().split("T")[0];

// Distinct 555-exchange numbers (fictional NANP → never a real customer).
const PHONE_D1_NOTIFIED = "16045551201"; // already notified for D1, in-window
const PHONE_D2_PROMOTED = "16045551203"; // next-in-line for D2 → should win

test.describe("Waitlist advance cron", () => {
  let testSlug: string;
  let salonId: string;
  let serviceId: string;
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
    const d1 = new Date(now + 24 * 60 * 60 * 1000); // tomorrow
    const d2 = new Date(now + 48 * 60 * 60 * 1000); // day after
    d2Ymd = ymd(d2);

    const base = {
      salon_id: salonId,
      service_id: serviceId,
      source: "slot_unavailable",
    };

    await supabase.from("booking_waitlist_entries" as never).insert([
      // A — date D1, freshly notified 5 min ago (still in its 20-min window).
      // Must NOT be touched by the D2 advance. Its older notified_at is exactly
      // what the buggy ASC-ordered picker latched onto.
      {
        ...base,
        booking_date: ymd(d1),
        client_name: "D1 Already Notified",
        client_phone: PHONE_D1_NOTIFIED,
        status: "notified",
        claim_token: "11111111-1111-1111-1111-111111111111",
        claimed_at: null,
        notified_at: new Date(now - 5 * 60 * 1000).toISOString(),
      },
      // B — date D2, notified 30 min ago → EXPIRED → the cron flips it to
      // 'expired' and promotes the next D2 waiter (C).
      {
        ...base,
        booking_date: d2Ymd,
        client_name: "D2 Expired",
        client_phone: "16045551202",
        status: "notified",
        claim_token: "22222222-2222-2222-2222-222222222222",
        claimed_at: null,
        notified_at: new Date(now - 30 * 60 * 1000).toISOString(),
      },
      // C — date D2, waiting → should be promoted + notified by this run.
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

  test("advance promotes the next D2 waiter and notifies THAT person, not the in-window D1 entry", async ({
    page,
  }) => {
    // Auth: the test runner and the dev server both load .env.local, so if
    // CRON_SECRET is set it matches on both sides; when unset (CI) the route
    // passes with no header (undefined === undefined).
    const secret = process.env.CRON_SECRET;
    const res = await page.request.get("/api/cron/waitlist-advance", {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
    expect(res.ok(), `cron responded ${res.status()}: ${await res.text()}`).toBe(true);
    const body = (await res.json()) as { ok?: boolean; advanced?: number };
    expect(body.ok).toBe(true);
    expect(body.advanced).toBeGreaterThanOrEqual(1);

    const supabase = createServiceRoleClient();

    // The expired D2 entry (B) is now 'expired'; the D2 waiter (C) is promoted.
    const { data: entries } = await supabase
      .from("booking_waitlist_entries" as never)
      .select("client_phone, status, claim_token")
      .eq("salon_id", salonId);
    const byPhone = Object.fromEntries(
      (entries as Array<{ client_phone: string; status: string; claim_token: string | null }>).map(
        (e) => [e.client_phone, e],
      ),
    );
    expect(byPhone["16045551202"].status).toBe("expired");
    expect(byPhone[PHONE_D2_PROMOTED].status).toBe("notified");
    expect(byPhone[PHONE_D2_PROMOTED].claim_token).not.toBeNull();
    // The in-window D1 entry is left untouched.
    expect(byPhone[PHONE_D1_NOTIFIED].status).toBe("notified");

    // The waitlist_invite SMS went to the promoted D2 person — and ONLY them.
    const { data: notes } = await supabase
      .from("booking_notifications" as never)
      .select("client_phone, body_preview, notification_type, channel")
      .eq("salon_id", salonId)
      .eq("notification_type", "waitlist_invite")
      .eq("channel", "sms");
    const rows = (notes ?? []) as Array<{ client_phone: string; body_preview: string | null }>;

    const recipients = rows.map((r) => r.client_phone);
    expect(recipients).toContain(PHONE_D2_PROMOTED);
    // Regression assertion: the in-window D1 customer must NOT be re-notified.
    expect(recipients).not.toContain(PHONE_D1_NOTIFIED);

    // And the SMS names the correct (D2) date.
    const promotedNote = rows.find((r) => r.client_phone === PHONE_D2_PROMOTED);
    expect(promotedNote?.body_preview).toContain(d2Ymd);
  });
});
