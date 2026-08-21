import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const sequenceSql = read(
  "supabase/migrations/20260820180036_add_authoritative_booking_service_sequences.sql",
);
const managementSql = read(
  "supabase/migrations/20260820140000_add_action_scoped_booking_management_capabilities.sql",
);
const deskEdit = read("src/shared/dashboard/editBookingCore.ts");
const voice = read("src/shared/voiceai/toolExecutor.ts");

function functionBody(source: string, signature: string, nextSignature?: string) {
  const start = source.indexOf(signature);
  expect(start, `${signature} must exist`).toBeGreaterThan(-1);
  const end = nextSignature ? source.indexOf(nextSignature, start + signature.length) : -1;
  return source.slice(start, end > start ? end : undefined);
}

describe("multi-service sequence lifecycle acceptance", () => {
  it("keeps parent anchor times equal to the first/last persisted segment and verifies them on replay", () => {
    const create = functionBody(
      sequenceSql,
      "CREATE OR REPLACE FUNCTION public.create_public_booking_sequence",
    );
    expect(sequenceSql).toMatch(
      /'parent_start_time_utc',\s*\(v_final_lines->0->>'customer_start_utc'\)::timestamptz/,
    );
    expect(sequenceSql).toMatch(
      /'parent_end_time_utc',\s*\(v_final_lines->\(pg_catalog\.jsonb_array_length\(v_final_lines\)-1\)->>'customer_end_utc'\)::timestamptz/,
    );
    expect(create).toMatch(
      /start_time_utc[\s\S]{0,900}?\(v_quote->>'parent_start_time_utc'\)::timestamptz[\s\S]{0,120}?\(v_quote->>'parent_end_time_utc'\)::timestamptz/,
    );
    expect(create).toMatch(
      /v_existing\.start_time_utc IS DISTINCT FROM[\s\S]{0,180}?parent_start_time_utc[\s\S]{0,180}?v_existing\.end_time_utc IS DISTINCT FROM[\s\S]{0,180}?parent_end_time_utc/,
    );
  });

  it("releases every child reservation when the parent is cancelled, no-show, or completed", () => {
    const sync = functionBody(
      sequenceSql,
      "CREATE OR REPLACE FUNCTION public.sync_booking_service_segment_status",
      "CREATE TRIGGER sync_booking_service_segment_status",
    );
    expect(sync).toContain("UPDATE public.booking_service_segments");
    expect(sync).toMatch(/seg\.booking_id\s*=\s*NEW\.id/);
    expect(sync).toMatch(/ELSE NEW\.status/);
    expect(sequenceSql).toMatch(
      /reservation_status NOT IN \('cancelled', 'no_show', 'completed'\)/,
    );
  });

  it("customer capability reschedule atomically moves the sequence or fails closed before parent write", () => {
    const apply = functionBody(
      managementSql,
      "CREATE OR REPLACE FUNCTION public.booking_management_apply_individual",
      "CREATE OR REPLACE FUNCTION public.confirm_booking_with_management_capability",
    );
    const hasLocalGuard = /schedule_model\s*=\s*'segments_v1'[\s\S]{0,500}?(reschedule_booking_sequence|sequence_reschedule_not_supported)/
      .test(apply);
    const parentGuard = functionBody(
      sequenceSql,
      "CREATE OR REPLACE FUNCTION public.protect_sequence_parent_schedule",
      "REVOKE ALL ON FUNCTION public.protect_sequence_parent_schedule",
    );
    const hasGlobalParentGuard = parentGuard.includes("IF OLD.schedule_model = 'segments_v1'")
      && parentGuard.includes("NEW.start_time_utc IS DISTINCT FROM OLD.start_time_utc")
      && parentGuard.includes("NEW.end_time_utc IS DISTINCT FROM OLD.end_time_utc")
      && parentGuard.includes("RAISE EXCEPTION")
      && /CREATE TRIGGER protect_sequence_parent_schedule[\s\S]*?BEFORE UPDATE OF[\s\S]*?start_time_utc, end_time_utc[\s\S]*?ON public\.bookings[\s\S]*?EXECUTE FUNCTION public\.protect_sequence_parent_schedule\(\);/
        .test(sequenceSql);
    expect(hasLocalGuard || hasGlobalParentGuard).toBe(true);
  });

  it("desk and Voice legacy reschedule paths fail closed before mutating a sequence parent", () => {
    expect(deskEdit).toMatch(/select\([\s\S]{0,260}?schedule_model/);
    expect(deskEdit).toMatch(
      /schedule_model[\s\S]{0,500}?(sequence_reschedule_not_supported|segments_v1)/,
    );
    expect(voice).toMatch(
      /\.select\("id, salon_id,[^"]*schedule_model[^"]*"\)/,
    );
    expect(voice).toMatch(
      /schedule_model[\s\S]{0,500}?(sequence_reschedule_not_supported|segments_v1)/,
    );
  });

  it("exposes a service-only persisted sequence receipt loader", () => {
    const receipt = functionBody(
      sequenceSql,
      "CREATE OR REPLACE FUNCTION public.load_booking_sequence_receipt",
    );
    expect(receipt).toContain("FROM public.booking_service_segments seg");
    expect(sequenceSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.load_booking_sequence_receipt\(uuid, uuid\)[\s\S]{0,180}?FROM PUBLIC, anon, authenticated/,
    );
  });
});
