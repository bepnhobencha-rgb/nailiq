import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260807050330_archived_booking_recovery.sql",
  ),
  "utf8",
);
const actions = readFileSync(
  resolve(process.cwd(), "src/shared/dashboard/receptionistActions.ts"),
  "utf8",
);

describe("archived booking recovery database boundary", () => {
  it("adds an all-or-none, immutable audit link without replacing the source", () => {
    expect(migration).toContain("recovered_from_booking_id uuid");
    expect(migration).toContain("recovery_kind text");
    expect(migration).toContain("recovered_by_user_id uuid");
    expect(migration).toContain("bookings_recovery_metadata_check");
    expect(migration).toContain("'cancelled_rebook', 'no_show_walkin'");
    expect(migration).toContain("on delete restrict");
    expect(migration).toContain("booking recovery metadata is immutable");
    expect(migration).toContain(
      "old.idempotency_key is distinct from new.idempotency_key",
    );
    expect(migration).toMatch(
      /before insert or update of[\s\S]*status,[\s\S]*idempotency_key/i,
    );
  });

  it("deduplicates both the archived source and nullable-staff recovery requests", () => {
    expect(migration).toMatch(
      /create unique index if not exists bookings_one_recovery_per_source_uidx[\s\S]*recovered_from_booking_id is not null/i,
    );
    expect(migration).toMatch(
      /create unique index if not exists bookings_recovery_idempotency_uidx[\s\S]*\(salon_id, idempotency_key\)[\s\S]*recovered_from_booking_id is not null/i,
    );
    expect(migration).toContain("booking recovery requires an idempotency key");
  });

  it("enforces tenant, terminal-state, replacement-shape, flag, and actor invariants", () => {
    expect(migration).toContain("v_source.salon_id <> new.salon_id");
    expect(migration).toContain("v_source.status <> 'cancelled'");
    expect(migration).toContain("v_source.status <> 'no_show'");
    expect(migration).toContain("new.source <> 'appointment'");
    expect(migration).toContain("new.source <> 'walkin'");
    expect(migration).toContain("new.status <> 'waiting'");
    expect(migration).toContain("archived_booking_recovery_enabled");
    expect(migration).toContain("pf.key = 'feature_archived_booking_recovery'");
    expect(migration).toContain("pf.enabled = false");
    expect(migration).toContain("disabled platform-wide");
    expect(migration).toContain("old.status in ('cancelled', 'no_show')");
    expect(migration).toContain("new.status is distinct from old.status");
    expect(migration).toContain(
      "terminal booking identity and schedule are immutable",
    );
    expect(migration).toContain(
      "new.salon_id is distinct from old.salon_id",
    );
    expect(migration).toContain("new.source is distinct from old.source");
    expect(migration).toMatch(
      /before insert or update of[\s\S]*salon_id,[\s\S]*source,[\s\S]*client_phone,[\s\S]*idempotency_key/i,
    );
    expect(migration).toContain("sm.role in ('owner', 'admin')");
    expect(migration).toContain("v_authenticated_user_id <> new.recovered_by_user_id");
    expect(migration).toContain("child.recovered_from_booking_id = old.id");
    expect(migration).toContain("if v_has_recovery or (");
    expect(migration).toContain(
      "not available for Wix-connected salons",
    );
  });

  it("validates the creation shape once but permits the replacement's normal lifecycle", () => {
    expect(migration).toMatch(
      /if tg_op = 'UPDATE'[\s\S]*old\.recovered_from_booking_id is not null then[\s\S]*return new;/i,
    );
    expect(migration).toContain(
      "waiting -> confirmed/in_progress/",
    );
  });

  it("keeps the hardened trigger helper closed to browser RPC calls", () => {
    expect(migration).toMatch(
      /function public\.validate_archived_booking_recovery\(\)[\s\S]*language plpgsql[\s\S]*security definer[\s\S]*set search_path = ''/i,
    );
    expect(migration).toContain("set search_path = ''");
    expect(migration).toMatch(
      /revoke all on function public\.validate_archived_booking_recovery\(\)[\s\S]*from public, anon, authenticated/i,
    );
    expect(migration).not.toMatch(/current_user\s+in/i);
    expect(migration).not.toMatch(/current_user\s+not\s+in/i);
    expect(migration).toContain(
      "session_user not in ('postgres', 'supabase_admin')",
    );
  });

  it("protects the rollout key from broad salon-member feature flag writes", () => {
    expect(migration).toContain(
      "function public.protect_archived_booking_recovery_flag()",
    );
    expect(migration).toContain(
      "archived booking recovery flag is service-controlled",
    );
    expect(migration).toMatch(
      /before insert or update of feature_flags[\s\S]*on public\.salons/i,
    );
    expect(migration).toMatch(
      /revoke all on function public\.protect_archived_booking_recovery_flag\(\)[\s\S]*from public, anon, authenticated/i,
    );
    expect(migration).toContain(
      "session_user in ('postgres', 'supabase_admin')",
    );
  });

  it("creates a cancelled replacement atomically through a private RPC", () => {
    expect(migration).toContain("create or replace function public.create_recovered_booking(");
    expect(migration).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(migration).toContain("v_source_status <> 'cancelled'");
    expect(migration).toContain("v_source_salon_id <> p_salon_id");
    expect(migration).toContain("'code', 'already_recovered'");
    expect(migration).toContain("'replayed', true");
    expect(migration).toContain("v_result := public.create_public_booking(");
    expect(migration).toContain("null::uuid");
    expect(migration).toContain("null::integer");
    expect(migration).toContain("raise exception 'recovered booking stamp failed'");
  });

  it("treats the exact same request as a successful replay and keeps no-show recovery waiting", () => {
    expect(actions).toContain("isSameArchivedBookingRecovery");
    expect(actions).toContain(
      "return { ok: true, bookingId: recoveryResult.existingBookingId }",
    );
    expect(actions).toMatch(
      /if \(input\.recovery \|\| !autoAssign\)[\s\S]*return created;/,
    );
  });

  it("defaults recovery outbound confirmations off and blocks unsynchronised Wix recovery", () => {
    expect(actions).toContain("external_calendar_not_supported");
    expect(actions).toMatch(
      /const notifyCreateSms = recovery[\s\S]*input\.notify\?\.sms === true/,
    );
    expect(actions).toMatch(
      /const notifyCreateEmail = recovery[\s\S]*input\.notify\?\.email === true/,
    );
    expect(actions).toContain("if (!recovery) after(() => pushWixCreate");
  });

  it("allows only service_role to execute the recovery RPC", () => {
    expect(migration).toMatch(
      /revoke all on function public\.create_recovered_booking\([\s\S]*?\) from public, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.create_recovered_booking\([\s\S]*?\) to service_role/i,
    );
  });
});
