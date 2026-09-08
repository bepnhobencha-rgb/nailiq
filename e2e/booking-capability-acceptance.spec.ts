import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { cleanupTestSalon, seedTestSalon } from "./helpers/db";
import { supabaseAdmin as db } from "./receptionist-center/helpers";
let slug: string;
const scopes = ["confirm", "reschedule", "cancel", "card_manage"] as const;
type Scope = typeof scopes[number] | "status";
let salonId: string;
let bookingId: string;
let start: string;
async function rpc(name: string, args: Record<string, unknown>) {
  const r = await db.rpc(name, args);
  expect(r.error, name).toBeNull();
  return r.data as Record<string, unknown>;
}
async function mint(scope: Scope, expires = new Date(Date.now() + (scope === "card_manage" ? 600000 : 3600000)).toISOString()) {
  const r = await rpc("mint_booking_management_capability", { p_salon_id: salonId, p_booking_id: bookingId, p_action: scope, p_min_expires_at: expires });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(typeof r.token_id).toBe("string");
  return r.token_id as string;
}
async function inspect(token: string, scope: Scope) {
  return rpc("inspect_booking_management_capability", { p_token_id: token, p_expected_action: scope });
}
async function booking() {
  const r = await db.from("bookings").select("status,start_time_utc,end_time_utc").eq("id", bookingId).single();
  expect(r.error).toBeNull();
  return r.data!;
}
async function receiptCount() {
  const r = await db.from("booking_management_action_receipts").select("id", { count: "exact", head: true }).eq("booking_id", bookingId);
  expect(r.error).toBeNull();
  return r.count;
}
test.beforeEach(async ({}, info) => {
  slug = `e2e-capability-${info.project.name}-${randomUUID().slice(0, 8)}`;
  ({ salonId } = await seedTestSalon({ slug, name: "E2E Capability Acceptance", phone: "16045550171" }));
  // Each test owns a unique salon, including when CI shards overlap.
  // A synthetic all-week schedule keeps transitions independent of the weekday.
  const hours = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(day => [day, { open: "09:00", close: "18:00", closed: false }]));
  const schedule = await db.from("salons").update({ opening_hours: hours }).eq("id", salonId);
  expect(schedule.error).toBeNull();
  const service = await db.from("services").select("id").eq("salon_id", salonId).limit(1).single();
  expect(service.error).toBeNull();
  const staff = await db.from("staff").select("id").eq("salon_id", salonId).limit(1).single();
  expect(staff.error).toBeNull();
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 14);
  date.setUTCHours(19, 0, 0, 0);
  start = date.toISOString();
  bookingId = randomUUID();
  const r = await db.from("bookings").insert({ id: bookingId, salon_id: salonId, service_id: service.data!.id, staff_id: staff.data!.id, client_name: "QA Capability Guest", client_phone: "16045550172", client_email: "capability@example.invalid", start_time_utc: start, end_time_utc: new Date(date.getTime() + 30 * 60000).toISOString(), status: "pending", price_cents: 3000 });
  expect(r.error).toBeNull();
});
test.afterEach(async ({ page }) => {
  try {
    await page.goto("about:blank");
  } finally {
    await cleanupTestSalon(slug);
  }
});
test("MQA-0099: email-link GET is preview-only and explicit POST performs confirmation", async ({ page, request }, info) => {
  const token = await mint("confirm");
  const initial = await booking();
  for (let i = 0; i < 3; i++) {
    const r = await request.get(`/api/booking/confirm-action?token=${token}`);
    expect(r.ok()).toBe(true);
    expect((await r.json()).ok).toBe(true);
  }
  expect(await booking()).toEqual(initial);
  expect(await receiptCount()).toBe(0);
  await page.goto(`/booking/confirm?token=${token}`);
  const confirm = page.getByRole("button", { name: "Yes, confirm my appointment" });
  await expect(confirm).toBeVisible();
  expect(await booking()).toEqual(initial);
  expect(await receiptCount()).toBe(0);
  await page.screenshot({ path: info.outputPath("confirmation-preview.png") });
  const response = page.waitForResponse(r => r.url().includes("/api/booking/confirm-action") && r.request().method() === "POST");
  await confirm.click();
  expect((await response).ok()).toBe(true);
  await expect.poll(async () => (await booking()).status).toBe("confirmed");
  expect(await receiptCount()).toBe(1);
});
test("MQA-0099: confirm, reschedule, cancel, and card-management capabilities have independent scopes", async () => {
  const tokens = await Promise.all(scopes.map(s => mint(s)));
  expect(new Set(tokens).size).toBe(4);
  for (let i = 0; i < scopes.length; i++)
    for (let j = 0; j < scopes.length; j++) {
      const r = await inspect(tokens[i], scopes[j]);
      expect(r.code === "valid").toBe(i === j);
      if (i !== j)
        expect(r.booking).toBeUndefined();
    }
  expect(await receiptCount()).toBe(0);
});
test("MQA-0099: using Confirm does not invalidate Reschedule or Cancel from the same reminder", async () => {
  const [confirm, reschedule, cancel] = await Promise.all([mint("confirm"), mint("reschedule"), mint("cancel")]);
  const requestId = randomUUID();
  const r = await rpc("confirm_booking_with_management_capability", { p_token_id: confirm, p_request_id: requestId });
  expect(r.code).toBe("confirmed");
  const replay = await rpc("confirm_booking_with_management_capability", { p_token_id: confirm, p_request_id: requestId });
  expect(replay.idempotent).toBe(true);
  expect((await inspect(reschedule, "reschedule")).code).toBe("valid");
  expect((await inspect(cancel, "cancel")).code).toBe("valid");
  expect(await receiptCount()).toBe(1);
});
test("MQA-0099: requested appointment-long expiry is never shortened by reuse of a 48-hour token", async () => {
  const short = await mint("status", new Date(Date.now() + 48 * 3600000).toISOString());
  const requested = new Date(Date.parse(start) + 3600000).toISOString();
  const longer = await mint("status", requested);
  const row = await db.from("booking_management_capabilities").select("expires_at,revoked_at").eq("id", longer).single();
  expect(row.error).toBeNull();
  expect(Date.parse(row.data!.expires_at)).toBeGreaterThanOrEqual(Date.parse(requested));
  expect(row.data!.revoked_at).toBeNull();
  if (short !== longer)
    expect((await inspect(short, "status")).code).not.toBe("valid");
  expect((await inspect(longer, "status")).code).toBe("valid");
});
test("MQA-0099: concurrent token minting leaves one authoritative usable capability per scope", async () => {
  const expiry = new Date(Date.parse(start) + 3600000).toISOString();
  for (const scope of scopes) {
    const scopeExpiry = scope === "card_manage" ? new Date(Date.now() + 600000).toISOString() : expiry;
    const tokens = await Promise.all(Array.from({ length: 12 }, () => mint(scope, scopeExpiry)));
    expect(new Set(tokens).size, scope).toBe(1);
    const rows = await db.from("booking_management_capabilities").select("id").eq("booking_id", bookingId).eq("action", scope).is("revoked_at", null);
    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(1);
    expect(rows.data![0].id).toBe(tokens[0]);
    expect((await inspect(tokens[0], scope)).code).toBe("valid");
  }
});
test("MQA-0099: reschedule/cancel transitions invalidate stale action capabilities for the old state", async () => {
  const old = await Promise.all(scopes.map(s => mint(s)));
  const newStart = new Date(Date.parse(start) + 86400000).toISOString();
  const moved = await rpc("reschedule_booking_with_management_capability", { p_token_id: old[1], p_request_id: randomUUID(), p_new_start_utc: newStart, p_new_end_utc: new Date(Date.parse(newStart) + 30 * 60000).toISOString() });
  expect(moved.code).toBe("rescheduled");
  expect((await inspect(old[1], "reschedule")).code).not.toBe("valid");
  expect((await inspect(old[2], "cancel")).code).toBe("stale_booking");
  // Confirmation and unchanged card state retain their independent scope.
  expect((await inspect(old[0], "confirm")).code).toBe("valid");
  expect((await inspect(old[3], "card_manage")).code).toBe("valid");
  const current = await Promise.all(scopes.map(s => mint(s)));
  const cancelled = await rpc("cancel_booking_with_management_capability", { p_token_id: current[2], p_request_id: randomUUID() });
  expect(cancelled.code).toBe("cancelled");
  for (let i = 0; i < scopes.length; i++)
    expect((await inspect(current[i], scopes[i])).code).not.toBe("valid");
  expect((await booking()).status).toBe("cancelled");
});
test("MQA-0099: public booking-status URL requires a bounded capability instead of a naked booking id", async ({ page, request }) => {
  for (const query of [`bookingId=${bookingId}`, `token=${bookingId}`]) {
    const r = await request.get(`/api/booking/status?${query}`);
    expect(r.ok()).toBe(false);
    expect((await r.json()).booking).toBeUndefined();
  }
  const token = await mint("status");
  const ok = await request.get(`/api/booking/status?token=${token}`);
  expect(ok.ok()).toBe(true);
  expect(ok.headers()["cache-control"]).toContain("no-store");
  const loaded = page.waitForResponse(r => r.url().includes("/api/booking/status?token="));
  await page.goto(`/booking/status?token=${token}`);
  expect((await loaded).ok()).toBe(true);
  await expect(page.getByText("pending", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "View salon" })).toHaveAttribute("href", `/${slug}`);
  const expired = await db.from("booking_management_capabilities").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", token);
  expect(expired.error).toBeNull();
  const denied = await request.get(`/api/booking/status?token=${token}`);
  expect(denied.status()).toBe(410);
  expect((await denied.json()).booking).toBeUndefined();
  await page.reload();
  await expect(page.getByText("This status link is invalid or has expired.")).toBeVisible();
  await expect(page.getByRole("link", { name: "View salon" })).toHaveCount(0);
});
