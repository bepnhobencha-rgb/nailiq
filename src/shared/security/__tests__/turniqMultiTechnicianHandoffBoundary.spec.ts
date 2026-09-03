import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260903201935_add_turniq_multi_technician_handoff_ledger.sql",
  ),
  "utf8",
);

const requestedStaffIndexHotfix = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260903213426_add_turniq_handoff_requested_staff_index.sql",
  ),
  "utf8",
);

describe("TurnIQ M4R multi-technician handoff boundary", () => {
  it("models one immutable performer assignment across one or more segments", () => {
    expect(migration).toContain("CREATE TABLE public.turniq_handoff_plans");
    expect(migration).toContain("CREATE TABLE public.turniq_handoff_performers");
    expect(migration).toContain("CREATE TABLE public.turniq_handoff_plan_items");
    expect(migration).toContain("reject_turniq_handoff_performer_mutation");
    expect(migration).toContain("UNIQUE (salon_id, handoff_plan_id, proposed_staff_id)");
    expect(migration).toContain("'turns_to_consume', 1");
  });

  it("keeps the committed booking segment material authoritative", () => {
    const record = migration.slice(
      migration.indexOf(
        "CREATE OR REPLACE FUNCTION public.record_turniq_handoff_plan_v1",
      ),
      migration.indexOf(
        "CREATE OR REPLACE FUNCTION public.confirm_turniq_handoff_plan_v1",
      ),
    );
    expect(record).toContain("v_segment.staff_id IS DISTINCT FROM v_staff_id");
    expect(record).toContain("v_segment.resource_id IS DISTINCT FROM v_resource_id");
    expect(record).toContain("v_segment.occupied_start_utc IS DISTINCT FROM");
    expect(record).toContain("TurnIQ handoff booking material changed");
    expect(record).not.toMatch(/UPDATE public\.bookings|UPDATE public\.booking_service_segments/);
  });

  it("revalidates the entire plan before confirming any performer", () => {
    const confirm = migration.slice(
      migration.indexOf(
        "CREATE OR REPLACE FUNCTION public.confirm_turniq_handoff_plan_v1",
      ),
      migration.indexOf(
        "CREATE OR REPLACE FUNCTION public.apply_turniq_handoff_performer_command_v1",
      ),
    );
    expect(confirm).toContain("booking-capacity:sequence:");
    expect(confirm).toContain("booking-capacity:staff:");
    expect(confirm).toContain("booking-capacity:resource:");
    expect(confirm).toContain("TurnIQ handoff segment facts changed; refresh required");
    expect(confirm.indexOf("FOR v_item IN")).toBeLessThan(
      confirm.indexOf("UPDATE public.bookings b"),
    );
    expect(confirm.indexOf("UPDATE public.bookings b")).toBeLessThan(
      confirm.indexOf("UPDATE public.turniq_assignments a"),
    );
  });

  it("stores one durable handoff Fairness Receipt per performer", () => {
    expect(migration).toContain(
      "ADD COLUMN handoff_detail jsonb NOT NULL DEFAULT '{}'::jsonb",
    );
    expect(migration).toContain("INSERT INTO public.turniq_fairness_receipts");
    expect(migration).toContain("'segments', coalesce(jsonb_agg(jsonb_build_object(");
    expect(migration).toContain("'requestedTechSource', i.requested_tech_source");
    expect(migration).toContain("'requestTrustLabel', i.request_trust_label");
  });

  it("requires supervised/live and exact command replay for every mutation", () => {
    expect(migration).toContain("NOT IN ('supervised', 'live')");
    expect(migration).toContain("turniq_replay_online_command");
    expect(migration).toContain("turniq_store_online_command");
    expect(migration).toContain("'recommend_handoff'");
    expect(migration).toContain("'confirm_handoff'");
    expect(migration).toContain(
      "requested-technician fallback requires owner or admin confirmation",
    );
  });

  it("keeps browser roles out and all new ledgers behind forced RLS", () => {
    expect(migration).not.toContain("SECURITY DEFINER");
    for (const table of [
      "turniq_handoff_plans",
      "turniq_handoff_performers",
      "turniq_handoff_plan_items",
    ]) {
      expect(migration).toContain(
        `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`,
      );
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE public\\.${table}[\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`,
        ),
      );
    }
    expect(migration).not.toMatch(/GRANT[^;]*TO anon|GRANT[^;]*TO authenticated/i);
  });

  it("covers every handoff item foreign-key lookup used during reconciliation", () => {
    expect(migration).toContain("turniq_handoff_item_segment_fk_idx");
    expect(migration).toContain("turniq_handoff_item_performer_fk_idx");
    expect(migration).toContain("turniq_handoff_item_staff_fk_idx");
    expect(requestedStaffIndexHotfix).toContain(
      "turniq_handoff_item_requested_staff_fk_idx",
    );
    expect(requestedStaffIndexHotfix).toContain(
      "WHERE requested_staff_id IS NOT NULL",
    );
    expect(migration).toContain("turniq_handoff_item_resource_fk_idx");
  });

  it("does not call payment or notification providers", () => {
    expect(migration).not.toMatch(/twilio|resend|square|stripe|payment_intent/i);
    expect(migration).not.toMatch(/http_post|net\.http|pg_net/i);
  });
});
