/**
 * Regression test for the booking_notifications.sent_at NOT NULL bug.
 *
 * logNotification() records BOTH successful and failed sends. A FAILED send has
 * no sent_at and instead sets failed_at + error_message. The original schema had
 * `sent_at timestamptz NOT NULL`, so the failed-send INSERT was rejected with
 * Postgres 23502 — failed notifications were silently never recorded.
 *
 * Migration 20260529000000_booking_notifications_nullable_sent_at dropped the
 * NOT NULL. This test exercises the REAL logNotification code path (not a raw
 * INSERT) for both outcomes:
 *   - ok:false → row persists with status='failed', sent_at=null, failed_at set.
 *   - ok:true  → row persists with status='sent',   sent_at set,  failed_at null.
 *
 * If the constraint is ever reintroduced, the ok:false case returns null (the
 * 23502 is swallowed inside logNotification) and this test fails.
 *
 * Run: npm run test:e2e -- e2e/notification-log.spec.ts
 */
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { logNotification } from "@/shared/lib/notificationLog";
import { seedTestSalon, cleanupTestSalon } from "./helpers/db";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SLUG = "e2e-notif-log";
let salonId: string;

test.beforeAll(async () => {
  const seeded = await seedTestSalon({ slug: SLUG });
  salonId = seeded.salonId;
});

test.afterAll(async () => {
  // booking_notifications.salon_id has ON DELETE CASCADE, so removing the salon
  // cleans up any rows this test inserted.
  await cleanupTestSalon(SLUG);
});

// ─── The regression: a FAILED send must be recorded ───────────────

test("logNotification records a FAILED send (sent_at NULL) instead of being dropped", async () => {
  const id = await logNotification({
    bookingId: null,
    salonId,
    notificationType: "booking_confirmation",
    channel: "sms",
    clientPhone: "+16045550000",
    ok: false,
    errorMessage: "twilio_400",
    bodyPreview: "regression: failed send",
  });

  // Before the fix this was null (the 23502 NOT-NULL violation was swallowed).
  expect(id, "failed-send insert must succeed and return a row id").toBeTruthy();

  const { data: row } = await supabase
    .from("booking_notifications")
    .select("status, sent_at, failed_at, error_message")
    .eq("id", id!)
    .single();

  expect(row?.status).toBe("failed");
  expect(row?.sent_at, "failed send has no sent_at").toBeNull();
  expect(row?.failed_at, "failed send records failed_at").not.toBeNull();
  expect(row?.error_message).toBe("twilio_400");
});

// ─── Sanity: a successful send still logs correctly ───────────────

test("logNotification records a SUCCESSFUL send (sent_at set)", async () => {
  const id = await logNotification({
    bookingId: null,
    salonId,
    notificationType: "booking_confirmation",
    channel: "sms",
    clientPhone: "+16045550001",
    messageSid: "SMtest_regression",
    ok: true,
    bodyPreview: "regression: ok send",
  });

  expect(id, "successful-send insert must return a row id").toBeTruthy();

  const { data: row } = await supabase
    .from("booking_notifications")
    .select("status, sent_at, failed_at")
    .eq("id", id!)
    .single();

  expect(row?.status).toBe("sent");
  expect(row?.sent_at, "successful send records sent_at").not.toBeNull();
  expect(row?.failed_at, "successful send has no failed_at").toBeNull();
});
