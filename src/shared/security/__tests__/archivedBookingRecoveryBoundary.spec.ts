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
const terminalMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260813090000_enforce_terminal_booking_immutability.sql",
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
    expect(migration).toContain(
      "not available for Wix-connected salons",
    );
  });

  it("locks every operational terminal UPDATE independent of flags, actors, or linked children", () => {
    const terminalBlock = terminalMigration.match(
      /-- Terminal source identity and schedule[\s\S]*?raise exception 'terminal booking identity and schedule are immutable'[\s\S]*?end if;/i,
    )?.[0];

    expect(terminalBlock).toBeTruthy();
    expect(terminalBlock).toContain("old.status in ('cancelled', 'no_show')");
    expect(terminalBlock).toContain("new.status is distinct from old.status");
    expect(terminalBlock).toContain("new.deleted_at is distinct from old.deleted_at");
    expect(terminalBlock).not.toContain("archived_booking_recovery_enabled");
    expect(terminalBlock).not.toContain("feature_archived_booking_recovery");
    expect(terminalBlock).not.toContain("recovered_from_booking_id");
    expect(terminalBlock).not.toContain("v_request_role");
    expect(terminalMigration).toMatch(
      /before insert or update of[\s\S]*status,[\s\S]*deleted_at,[\s\S]*idempotency_key/i,
    );
    const triggerColumns = terminalMigration.match(
      /before insert or update of[\s\S]*?on public\.bookings/i,
    )?.[0];
    expect(triggerColumns).not.toContain("noshow_charge_status");
    expect(triggerColumns).not.toContain("noshow_fee_cents");
    expect(terminalMigration).toMatch(
      /revoke all on function public\.validate_archived_booking_recovery\(\)[\s\S]*from public, anon, authenticated/i,
    );
  });

  it("states the privileged hard-delete limit instead of overclaiming perpetual retention", () => {
    const triggerDefinition = terminalMigration.match(
      /create trigger validate_archived_booking_recovery_trigger[\s\S]*?execute function public\.validate_archived_booking_recovery\(\);/i,
    )?.[0];
    expect(triggerDefinition).toBeTruthy();
    expect(triggerDefinition).toContain("before insert or update of");
    expect(triggerDefinition).not.toMatch(/\bbefore\b[\s\S]*\bdelete\b/i);
    expect(terminalMigration).toContain(
      "This trigger deliberately does not claim to intercept DELETE",
    );
    expect(terminalMigration).toMatch(
      /separately-authorized account[\s\S]*erasure and retention workflows/,
    );
  });

  it("keeps stale terminal-mutation server actions as unconditional rejection shims", () => {
    for (const [name, nextName] of [
      ["undoNoShowBooking", "chargeNoShowFeeManual"],
      ["undoCancelBooking", "restoreCancelledBooking"],
      ["restoreCancelledBooking", "editBooking"],
    ] as const) {
      const section = actions.match(
        new RegExp(
          `export async function ${name}\\([\\s\\S]*?(?=export async function ${nextName}\\()`,
        ),
      )?.[0];

      expect(section, `${name} action body`).toBeTruthy();
      expect(section).toContain('return fail("immutable_terminal_state")');
      expect(section).not.toContain('.update({ status: "confirmed"');
    }
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

  it("commits cancelled and no-show recovery children with actor audit in one private RPC transaction", () => {
    expect(terminalMigration).toContain(
      "create or replace function public.create_recovered_booking(",
    );
    expect(terminalMigration).toContain(
      "create or replace function public.create_recovered_walkin(",
    );
    expect(terminalMigration).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(terminalMigration).toContain("v_source_status <> 'cancelled'");
    expect(terminalMigration).toContain("v_source_status <> 'no_show'");
    expect(terminalMigration).toContain("v_source_salon_id <> p_salon_id");
    expect(terminalMigration).toContain("'code', 'already_recovered'");
    expect(terminalMigration).toContain("'replayed', true");
    expect(terminalMigration).toContain(
      "v_result := public.create_public_booking(",
    );
    expect(terminalMigration).toContain(
      "insert into public.booking_events (",
    );
    expect(terminalMigration).toContain("'booking_recovered'");
    expect(terminalMigration).toContain(
      "returning id into v_audit_id",
    );
    expect(terminalMigration).toContain(
      "raise exception 'recovered booking audit insert failed'",
    );
    expect(terminalMigration).toContain(
      "raise exception 'recovered walk-in audit insert failed'",
    );
    expect(actions).toContain('"create_recovered_walkin" as never');
    expect(actions).not.toContain('eventType: "booking_recovered"');
    expect(actions).toContain('return fail("after_hours_not_allowed")');
  });

  it("treats the exact same request as a successful replay and keeps no-show recovery waiting", () => {
    expect(actions).toContain("isSameArchivedBookingRecovery");
    expect(actions).toContain(
      "Exact retries still pass through the service-only DB RPC",
    );
    expect(actions).toContain("recoveryResult.replayed === true");
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

  it("allows only service_role to execute both recovery RPCs", () => {
    expect(terminalMigration).toMatch(
      /revoke all on function public\.create_recovered_booking\([\s\S]*?\) from public, anon, authenticated/i,
    );
    expect(terminalMigration).toMatch(
      /grant execute on function public\.create_recovered_booking\([\s\S]*?\) to service_role/i,
    );
    expect(terminalMigration).toMatch(
      /revoke all on function public\.create_recovered_walkin\([\s\S]*?\) from public, anon, authenticated/i,
    );
    expect(terminalMigration).toMatch(
      /grant execute on function public\.create_recovered_walkin\([\s\S]*?\) to service_role/i,
    );
  });

  it("provides an audited, redaction-only privacy exception without changing terminal facts", () => {
    expect(terminalMigration).toContain(
      "create or replace function public.redact_terminal_booking_for_privacy(",
    );
    expect(terminalMigration).toContain(
      "sa.role in ('founder', 'ops_admin')",
    );
    expect(terminalMigration).toContain("v_request_role = 'service_role'");
    expect(terminalMigration).toContain(
      "session_user in ('postgres', 'supabase_admin')",
    );
    expect(terminalMigration).toContain("verified_erasure_request");
    expect(terminalMigration).not.toContain("trim(p_reason)");
    expect(terminalMigration).toContain(
      "privacy redaction may only remove direct customer identifiers",
    );
    expect(terminalMigration).toContain("client_name = '[removed]'");
    expect(terminalMigration).toContain("terminal_booking_privacy_redacted");
    expect(terminalMigration).toContain("terminalHistoryRetained");
    expect(terminalMigration).toContain(
      "returning id into v_audit_id",
    );
    expect(terminalMigration).toMatch(
      /revoke all on function public\.redact_terminal_booking_for_privacy\([\s\S]*?\) from public, anon, authenticated/i,
    );
    expect(terminalMigration).toMatch(
      /grant execute on function public\.redact_terminal_booking_for_privacy\([\s\S]*?\) to service_role/i,
    );
  });
});
