import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("MQA-0176 VIP policy boundary", () => {
  it("stores manual VIP recognition on a locked salon relationship", () => {
    const migration = read(
      "supabase/migrations/20260822220330_add_salon_scoped_vip_status.sql",
    );
    expect(migration).toContain("ALTER TABLE public.salon_clients");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS is_vip boolean NOT NULL DEFAULT false");
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("TO anon, authenticated");
    expect(migration).toContain("USING (false)");
    expect(migration).toContain("WITH CHECK (false)");
  });

  it("uses salon-local manual status or configured spend and visit thresholds", () => {
    const agent = read("src/shared/ai/agentVipCare.ts");
    expect(agent).toContain('.from("salon_clients")');
    expect(agent).toContain('.eq("salon_id", salonId)');
    expect(agent).toContain('.eq("is_vip", true)');
    expect(agent).toContain("parseVipSpendTiers(s.vip_spend_tiers).bronze");
    expect(agent).toContain("s.vip_visit_threshold");
    expect(agent).not.toContain('.eq("is_vip", true)\n        .in("id"');
  });

  it("creates review drafts and has no outbound or voucher side effect", () => {
    const agent = read("src/shared/ai/agentVipCare.ts");
    expect(agent).toContain('actionType: "vip_care_outreach_draft"');
    expect(agent).toContain('delivery_mode: "draft_only_human_send_required"');
    for (const forbidden of [
      "sendSmsReminder",
      "resend.emails.send",
      "sendOwnerAlert",
      '.from("vouchers"',
    ]) {
      expect(agent).not.toContain(forbidden);
    }
  });

  it("keeps VIP out of the receptionist priority algorithm", () => {
    const priority = read(
      "src/shared/dashboard/receptionistQueuePriority.ts",
    );
    expect(priority).not.toContain("is_vip");
    expect(priority).toContain("joined_queue_at");
    expect(priority).toContain("requested_staff_ready_at_iso");
  });
});
