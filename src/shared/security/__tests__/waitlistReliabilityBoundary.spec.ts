import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("waitlist reliability boundary", () => {
  const actions = read("src/shared/dashboard/receptionistActions.ts");
  const center = read("src/components/receptionist/ReceptionistCenter.tsx");
  const panel = read("src/components/receptionist/OnlineWaitlistPanel.tsx");
  const migration = read(
    "supabase/migrations/20260813090000_waitlist_acknowledgement_and_delivery_audit.sql",
  );

  it("keeps waitlist acknowledgement durable, tenant-scoped, and unresolved", () => {
    expect(migration).toContain("acknowledged_at timestamptz");
    expect(migration).toContain("acknowledged_by_user_id uuid");
    expect(actions).toMatch(
      /acknowledgeWaitlistEntries[\s\S]*getDashboardWriteClient\(slug\)[\s\S]*canCancelBooking\(ctx\.role\)/,
    );
    expect(actions).toMatch(
      /acknowledgeWaitlistEntries[\s\S]*\.eq\("salon_id", ctx\.salon\.id\)[\s\S]*\.eq\("status", "waiting"\)[\s\S]*\.is\("acknowledged_at", null\)/,
    );
    expect(actions).toContain(").slice(0, 50)");
    expect(actions).toContain('eventType: "waitlist_acknowledged"');
    expect(panel).toMatch(
      /status === "waiting" && !entry\.acknowledgedAt[\s\S]*acknowledgeWaitlistEntries\(slug, ids\)/,
    );
  });

  it("keeps the alert realtime and limits sound to one bounded reminder", () => {
    expect(center).toContain('table: "booking_waitlist_entries"');
    expect(center).toContain("const WAITLIST_REMINDER_DELAY_MS = 2 * 60 * 1000");
    expect(center).toContain('playAlert("new_waitlist")');
    expect(center).toMatch(
      /window\.setTimeout\([\s\S]*activeWaitlistIdsRef\.current\.has\(id\)[\s\S]*!acknowledgedWaitlistIdsRef\.current\.has\(id\)[\s\S]*playAlert\("new_waitlist"\)[\s\S]*WAITLIST_REMINDER_DELAY_MS/,
    );
    expect(center).not.toContain("setInterval(() => playAlert(\"new_waitlist\")");
  });

  it("links both delivery channels to the lead and suppresses rapid retries", () => {
    expect(migration).toContain("waitlist_entry_id uuid");
    expect(migration).toContain("booking_notifications_waitlist_entry_idx");
    expect(actions).toContain("const WAITLIST_INVITE_DEDUPE_MS = 30_000");
    expect(actions).toMatch(
      /\.eq\("waitlist_entry_id", id\)[\s\S]*\.in\("status", \["sending", "sent", "delivered"\]\)/,
    );
    expect(actions).toContain("return { ok: true, deduplicated: true }");
    expect(actions).toMatch(
      /waitlistEntryId: id,[\s\S]*channel: "sms"[\s\S]*waitlistEntryId: id,[\s\S]*channel: "email"/,
    );
    expect(actions).not.toMatch(/bodyPreview: (?:body|claimUrl)/);
    expect(actions).toContain('eventType: "waitlist_invited"');
  });
});
