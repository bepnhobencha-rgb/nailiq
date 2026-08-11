import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  graceDeadline,
  pauseTenant,
  resumeTenant,
  TENANT_PAUSE_FIELDS,
} from "./tenantPause";

function fakeDb(row: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    from() {
      return {
        select() {
          return { eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) };
        },
        update(patch: Record<string, unknown>) {
          updates.push(patch);
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    archived_at: null,
    tenant_pause_reason: null,
    tenant_pause_snapshot: null,
    sms_outbound_enabled: false,
    email_outbound_enabled: true,
    reminders_enabled: true,
    voice_ai_enabled: true,
    voice_ai_upsell_enabled: true,
    winback_enabled: true,
    phone_otp_enabled: true,
    email_links_enabled: true,
    ...overrides,
  };
}

describe("tenant pause controls", () => {
  it("captures NailIQ channel state and turns every outbound surface off", async () => {
    const { db, updates } = fakeDb(activeRow());
    const result = await pauseTenant(db, {
      salonId: "00000000-0000-4000-8000-000000000001",
      reason: "manual",
      note: "Owner requested pause",
    });
    expect(result.ok).toBe(true);
    expect(updates).toHaveLength(1);
    for (const key of TENANT_PAUSE_FIELDS) expect(updates[0]?.[key]).toBe(false);
    expect(updates[0]?.tenant_pause_snapshot).toMatchObject({
      sms_outbound_enabled: false,
      email_outbound_enabled: true,
      voice_ai_enabled: true,
    });
    expect(updates[0]).not.toHaveProperty("wix_access_token");
    expect(updates[0]).not.toHaveProperty("square_access_token");
  });

  it("does not replace the original snapshot on a repeated pause", async () => {
    const original = { email_outbound_enabled: true };
    const { db, updates } = fakeDb(
      activeRow({ archived_at: "2026-08-11T00:00:00Z", tenant_pause_snapshot: original }),
    );
    await pauseTenant(db, {
      salonId: "00000000-0000-4000-8000-000000000001",
      reason: "manual",
      note: "Retry",
    });
    expect(updates[0]).not.toHaveProperty("tenant_pause_snapshot");
  });

  it("restores only allow-listed channel booleans", async () => {
    const { db, updates } = fakeDb(
      activeRow({
        archived_at: "2026-08-11T00:00:00Z",
        tenant_pause_reason: "manual",
        tenant_pause_snapshot: {
          email_outbound_enabled: true,
          voice_ai_enabled: false,
          wix_access_token: "must-not-restore",
        },
      }),
    );
    const result = await resumeTenant(db, "00000000-0000-4000-8000-000000000001");
    expect(result.ok).toBe(true);
    expect(updates[0]).toMatchObject({
      archived_at: null,
      email_outbound_enabled: true,
      voice_ai_enabled: false,
    });
    expect(updates[0]).not.toHaveProperty("wix_access_token");
  });

  it("clamps payment grace to 1..30 days", () => {
    const now = new Date("2026-08-11T00:00:00Z");
    expect(graceDeadline(0, now)).toBe("2026-08-12T00:00:00.000Z");
    expect(graceDeadline(7, now)).toBe("2026-08-18T00:00:00.000Z");
    expect(graceDeadline(99, now)).toBe("2026-09-10T00:00:00.000Z");
  });
});
