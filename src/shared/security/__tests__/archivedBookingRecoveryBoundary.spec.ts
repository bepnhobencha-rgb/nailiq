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
const writeBoundaryMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260814090000_harden_terminal_booking_write_boundary.sql",
  ),
  "utf8",
);
const recoveryHardeningMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260814091000_harden_recovery_fingerprint_and_privacy.sql",
  ),
  "utf8",
);
const actions = readFileSync(
  resolve(process.cwd(), "src/shared/dashboard/receptionistActions.ts"),
  "utf8",
);
const twilioInbound = readFileSync(
  resolve(process.cwd(), "src/app/api/twilio/inbound/route.ts"),
  "utf8",
);
const voiceExecutor = readFileSync(
  resolve(process.cwd(), "src/shared/voiceai/toolExecutor.ts"),
  "utf8",
);
const squareSync = readFileSync(
  resolve(process.cwd(), "src/shared/integrations/square/sync.ts"),
  "utf8",
);
const wixSync = readFileSync(
  resolve(process.cwd(), "src/shared/integrations/wix/sync.ts"),
  "utf8",
);
const wixWriteback = readFileSync(
  resolve(process.cwd(), "src/shared/integrations/wix/writeback.ts"),
  "utf8",
);
const renameClientAction = readFileSync(
  resolve(process.cwd(), "src/shared/dashboard/renameClientAction.ts"),
  "utf8",
);
const editBookingNoteAction = readFileSync(
  resolve(process.cwd(), "src/shared/dashboard/editBookingNoteAction.ts"),
  "utf8",
);
const overrideNoShowPolicyAction = readFileSync(
  resolve(process.cwd(), "src/shared/dashboard/overrideNoShowPolicyAction.ts"),
  "utf8",
);
const removeCardRoute = readFileSync(
  resolve(process.cwd(), "src/app/api/booking/remove-card/route.ts"),
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
    expect(migration).toContain("new.salon_id is distinct from old.salon_id");
    expect(migration).toContain("new.source is distinct from old.source");
    expect(migration).toMatch(
      /before insert or update of[\s\S]*salon_id,[\s\S]*source,[\s\S]*client_phone,[\s\S]*idempotency_key/i,
    );
    expect(migration).toContain("sm.role in ('owner', 'admin')");
    expect(migration).toContain(
      "v_authenticated_user_id <> new.recovered_by_user_id",
    );
    expect(migration).toContain("not available for Wix-connected salons");
  });

  it("default-denies terminal INSERT, entry, UPDATE, and DELETE at the final trigger boundary", () => {
    const terminalBlock = writeBoundaryMigration.match(
      /create or replace function public\.enforce_terminal_booking_write_boundary\(\)[\s\S]*?\n\$\$;/i,
    )?.[0];

    expect(terminalBlock).toBeTruthy();
    expect(terminalBlock).toContain("if tg_op = 'DELETE'");
    expect(terminalBlock).toContain(
      "if tg_op = 'INSERT' and new.status in ('cancelled', 'no_show')",
    );
    expect(terminalBlock).toContain(
      "old.status not in ('cancelled', 'no_show')",
    );
    expect(terminalBlock).toContain("old.status in ('cancelled', 'no_show')");
    expect(terminalBlock).toContain(
      "terminal booking rows are immutable outside audited workflows",
    );
    expect(writeBoundaryMigration).toMatch(
      /before insert or update or delete on public\.bookings/i,
    );
    expect(writeBoundaryMigration).toMatch(
      /revoke all on function public\.enforce_terminal_booking_write_boundary\(\)[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(writeBoundaryMigration).toContain("automation may flag an");
    expect(writeBoundaryMigration).toContain(
      "overdue confirmed booking, but it may not decide attendance",
    );
    const autoReviewBlock = writeBoundaryMigration.match(
      /create or replace function public\.auto_mark_no_shows\(\)[\s\S]*?\n\$\$;/i,
    )?.[0];
    expect(autoReviewBlock).toContain("set no_show_candidate_at = now()");
    expect(autoReviewBlock).not.toContain("set status = 'no_show'");
  });

  it("permits terminal fee/privacy work only through booking-scoped audited capabilities", () => {
    expect(writeBoundaryMigration).toContain(
      "nailiq.terminal_fee_mutation_booking_id",
    );
    expect(writeBoundaryMigration).toContain(
      "terminal fee workflow attempted an unrelated booking mutation",
    );
    expect(writeBoundaryMigration).toContain(
      "create or replace function public.record_terminal_booking_fee_mutation(",
    );
    expect(writeBoundaryMigration).toContain(
      "terminal_booking_fee_mutation_recorded",
    );
    expect(writeBoundaryMigration).toContain("returning id into v_event_id");
    expect(recoveryHardeningMigration).toContain(
      "nailiq.privacy_redaction_booking_id",
    );
    const privacyCapability = writeBoundaryMigration.match(
      /if current_setting\('nailiq\.privacy_redaction_booking_id'[\s\S]*?return new;[\s\S]*?end if;/i,
    )?.[0];
    expect(privacyCapability).toContain("v_request_role <> 'service_role'");
    expect(privacyCapability).toContain(
      "terminal privacy redaction requires service role",
    );
    expect(writeBoundaryMigration).toContain(
      "only postgres/supabase_admin retain deliberate terminal retention authority",
    );
    const manualCharge = actions.match(
      /export async function chargeNoShowFeeManual\([\s\S]*?(?=export async function waiveNoShowFee\()/,
    )?.[0];
    expect(manualCharge).toContain("noshow_charge_attempts");
    expect(manualCharge).toContain("`retry-${retryAttempt}`");
    expect(manualCharge).not.toContain("crypto.randomUUID()");
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

  it("keeps ordinary desk price edits outside cancelled/no-show tombstones", () => {
    const section = actions.match(
      /export async function setBookingFinalPrice\([\s\S]*?(?=export async function)/,
    )?.[0];
    expect(section).toBeTruthy();
    expect(section).toContain(
      '.in("status", ["pending", "confirmed", "in_progress", "completed"])',
    );
    expect(section).not.toContain('.not("status", "eq", "cancelled")');
  });

  it("keeps ordinary name, note, and policy edits outside archived tombstones", () => {
    for (const source of [renameClientAction, editBookingNoteAction]) {
      expect(source).toContain('status === "cancelled" || status === "no_show"');
      expect(source).toContain('error: "immutable_terminal_state"');
      expect(source).toContain(
        '.in("status", ["pending", "confirmed", "in_progress", "completed", "waiting"])',
      );
    }
    expect(overrideNoShowPolicyAction).toContain(
      'if (!["pending", "confirmed"].includes(String(bk.status ?? "")))',
    );
    expect(overrideNoShowPolicyAction).toContain(
      '.in("status", ["pending", "confirmed"])',
    );
  });

  it("rejects voice reschedule of terminal rows and CAS-locks the final write to active state", () => {
    expect(voiceExecutor).toContain(
      'if (bookingStatus === "no_show")',
    );
    expect(voiceExecutor).toMatch(
      /\.update\(\{[\s\S]*?rescheduled_by: "voice"[\s\S]*?\.eq\("id", bookingId\)[\s\S]*?\.eq\("salon_id", salon\.id\)[\s\S]*?\.in\("status", \["pending", "confirmed"\]\)[\s\S]*?\.select\("id"\)[\s\S]*?\.maybeSingle\(\)/,
    );
    expect(voiceExecutor).toContain(
      'if (!updatedBooking?.id)',
    );
  });

  it("re-checks terminal state after the external remove-card call", () => {
    expect(removeCardRoute).toContain("recordThroughTerminalBoundary");
    expect(removeCardRoute).toContain(
      ".select(\"id\")\n      .maybeSingle()",
    );
    expect(removeCardRoute).toContain(
      "recordThroughTerminalBoundary = !cleared",
    );
    expect(removeCardRoute).toContain(
      "operation: \"card_removed\"",
    );
  });

  it("validates the creation shape once but permits the replacement's normal lifecycle", () => {
    expect(migration).toMatch(
      /if tg_op = 'UPDATE'[\s\S]*old\.recovered_from_booking_id is not null then[\s\S]*return new;/i,
    );
    expect(migration).toContain("waiting -> confirmed/in_progress/");
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
    expect(recoveryHardeningMigration).toContain(
      "create or replace function public.create_recovered_booking(",
    );
    expect(recoveryHardeningMigration).toContain(
      "create or replace function public.create_recovered_walkin(",
    );
    expect(recoveryHardeningMigration).toContain(
      "pg_catalog.pg_advisory_xact_lock",
    );
    expect(recoveryHardeningMigration).toContain(
      "v_source.status <> 'cancelled'",
    );
    expect(recoveryHardeningMigration).toContain(
      "v_source.status <> 'no_show'",
    );
    expect(recoveryHardeningMigration).toContain(
      "b.id = p_source_booking_id and b.salon_id = p_salon_id",
    );
    expect(recoveryHardeningMigration).toContain("else 'already_recovered'");
    expect(recoveryHardeningMigration).toContain("'replayed', true");
    expect(recoveryHardeningMigration).toContain(
      "v_result := public.create_public_booking(",
    );
    expect(recoveryHardeningMigration).toContain(
      "insert into public.booking_events (",
    );
    expect(recoveryHardeningMigration).toContain("'booking_recovered'");
    expect(recoveryHardeningMigration).toContain(
      "returning id into v_audit_id",
    );
    expect(recoveryHardeningMigration).toContain(
      "raise exception 'recovered booking audit insert failed'",
    );
    expect(recoveryHardeningMigration).toContain(
      "raise exception 'recovered walk-in audit insert failed'",
    );
    expect(actions).toContain('"create_recovered_walkin" as never');
    expect(actions).not.toContain('eventType: "booking_recovered"');
    expect(actions).toContain('return fail("after_hours_not_allowed")');
  });

  it("treats the exact same request as a successful replay and keeps no-show recovery waiting", () => {
    const addDeskAppointment = actions.match(
      /export async function addDeskAppointment\([\s\S]*?(?=export async function inviteWaitlistEntry\()/,
    )?.[0];
    const prevalidatedReplay = addDeskAppointment?.match(
      /if \(recoveryResult\.existingBookingId\) \{[\s\S]*?return \{ ok: true, bookingId: recoveryResult\.existingBookingId \};[\s\S]*?\}/,
    )?.[0];
    const atomicReplay = addDeskAppointment?.match(
      /if \(recovery && result\.replayed === true\) \{[\s\S]*?return \{ ok: true, bookingId \};[\s\S]*?\}/,
    )?.[0];

    expect(actions).toContain("isSameArchivedBookingRecovery");
    expect(actions).toContain(
      "Return that canonical result before mutable plan",
    );
    expect(actions).toContain("existingBookingId: existingResult.existing.id");
    expect(actions).toContain("recoveryResult.existingBookingId");
    expect(actions).toMatch(
      /if \(input\.recovery \|\| !autoAssign\)[\s\S]*return created;/,
    );
    expect(prevalidatedReplay).toBeTruthy();
    expect(atomicReplay).toBeTruthy();
    expect(prevalidatedReplay).not.toContain("handleBookingProtection");
    expect(atomicReplay).not.toContain("handleBookingProtection");
  });

  it("fingerprints the full normalized recovery request and resolves replay before mutable prerequisites", () => {
    expect(recoveryHardeningMigration).toContain(
      "recovery_request_fingerprint text",
    );
    expect(recoveryHardeningMigration).toContain(
      "SHA-256 of the normalized durable recovery intent",
    );
    expect(recoveryHardeningMigration).toContain(
      "v_existing.recovery_request_fingerprint = p_request_fingerprint",
    );
    expect(recoveryHardeningMigration).toContain("'idempotency_mismatch'");

    for (const marker of [
      "from unnest(coalesce(p_addon_service_ids",
      "v_result := public.create_public_booking(",
      "select s.price_cents into v_price_cents",
    ]) {
      expect(
        recoveryHardeningMigration.indexOf("select b.* into v_existing"),
      ).toBeGreaterThanOrEqual(0);
      expect(recoveryHardeningMigration.indexOf(marker)).toBeGreaterThan(
        recoveryHardeningMigration.indexOf("select b.* into v_existing"),
      );
    }
    expect(actions).toContain("archivedRecoveryFingerprint");
    expect(actions).toContain("recovery_request_fingerprint");
    expect(actions).toContain('fail("idempotency_mismatch")');
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
    expect(recoveryHardeningMigration).toMatch(
      /revoke all on function public\.create_recovered_booking\([\s\S]*?\) from public, anon, authenticated/i,
    );
    expect(recoveryHardeningMigration).toMatch(
      /grant execute on function public\.create_recovered_booking\([\s\S]*?\) to service_role/i,
    );
    expect(recoveryHardeningMigration).toMatch(
      /revoke all on function public\.create_recovered_walkin\([\s\S]*?\) from public, anon, authenticated/i,
    );
    expect(recoveryHardeningMigration).toMatch(
      /grant execute on function public\.create_recovered_walkin\([\s\S]*?\) to service_role/i,
    );
  });

  it("requires an explicit salon for system cancellation and revokes the id-only capability", () => {
    expect(writeBoundaryMigration).toContain(
      "create or replace function public.cancel_booking_by_id(\n  p_booking_id uuid,\n  p_salon_id uuid",
    );
    expect(writeBoundaryMigration).toContain("and salon_id = p_salon_id");
    expect(writeBoundaryMigration).toMatch(
      /revoke all on function public\.cancel_booking_by_id\(uuid\)[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(writeBoundaryMigration).toMatch(
      /grant execute on function public\.cancel_booking_by_id\(uuid, uuid\)[\s\S]*to service_role/i,
    );
    expect(twilioInbound).toMatch(
      /"cancel_booking_by_id" as never,[\s\S]*p_booking_id:[\s\S]*p_salon_id: booking\.salon_id/i,
    );
    expect(voiceExecutor).toMatch(
      /"cancel_booking_by_id" as never,[\s\S]*p_booking_id:[\s\S]*p_salon_id: salon\.id/i,
    );
  });

  it("routes Square-origin terminal states through a tenant and external-id scoped audit RPC", () => {
    expect(writeBoundaryMigration).toContain(
      "create or replace function public.transition_square_booking_to_terminal(",
    );
    expect(writeBoundaryMigration).toContain(
      "b.square_booking_id = p_square_booking_id",
    );
    expect(writeBoundaryMigration).toContain("square_sync_cancel");
    expect(writeBoundaryMigration).toContain("square_sync_no_show");
    expect(writeBoundaryMigration).toMatch(
      /revoke all on function public\.transition_square_booking_to_terminal\([\s\S]*?\) from public, anon, authenticated/i,
    );
    expect(writeBoundaryMigration).toMatch(
      /grant execute on function public\.transition_square_booking_to_terminal\([\s\S]*?\) to service_role/i,
    );
    expect(squareSync).toContain(
      '"transition_square_booking_to_terminal" as never',
    );
    expect(squareSync).toMatch(
      /if \(targetStatus === "cancelled" \|\| targetStatus === "no_show"\) \{[\s\S]*?terminalTransition = targetStatus;[\s\S]*?\} else \{[\s\S]*?updates\.status = targetStatus;/,
    );
    expect(squareSync).toMatch(
      /\.eq\("square_booking_id", b\.id\)[\s\S]*?\.eq\("salon_id", salonId\)/,
    );
    expect(squareSync).toMatch(
      /\.update\(updates\)[\s\S]*?\.eq\("id", existingId\)[\s\S]*?\.eq\("salon_id", salonId\)/,
    );
    expect(squareSync).toMatch(
      /\.update\(\{ square_booking_id: created\.id \} as never\)[\s\S]*?\.eq\("id", str\(r\.id\)\)[\s\S]*?\.eq\("salon_id", salonId\)/,
    );
  });

  it("fails Wix terminal imports closed and scopes every Wix booking lookup/write to its salon", () => {
    expect(wixSync).toMatch(
      /\.eq\("salon_id", ctx\.salonId\)[\s\S]*?\.eq\("wix_booking_id", b\.id\)/,
    );
    expect(wixSync).toContain('"cancel_booking_by_id" as never');
    expect(wixSync).toMatch(
      /p_booking_id: existingId,[\s\S]*?p_salon_id: ctx\.salonId/,
    );
    expect(wixSync).toContain(
      '!existingId && status === "cancelled"',
    );
    expect(wixSync.indexOf('select("id, status")')).toBeLessThan(
      wixSync.indexOf("const svc = await resolveService"),
    );
    expect(wixSync).toMatch(
      /\.update\(fields\)[\s\S]*?\.eq\("id", existingId\)[\s\S]*?\.eq\("salon_id", ctx\.salonId\)/,
    );
    expect(wixWriteback).toMatch(
      /\.select\("wix_booking_id"\)[\s\S]*?\.eq\("id", bookingId\)[\s\S]*?\.eq\("salon_id", salonId\)/,
    );
    expect(wixWriteback).toMatch(
      /\.update\(\{ wix_booking_id: wixBookingId \} as never\)[\s\S]*?\.eq\("id", bookingId\)[\s\S]*?\.eq\("salon_id", salonId\)[\s\S]*?\.in\("status", \["pending", "confirmed"\]\)/,
    );
  });

  it("never falls back to a partial-intent after-hours recovery insert", () => {
    const afterHoursInsert = actions.match(
      /if \(afterHoursMinutes != null\) \{[\s\S]*?\n  \} else \{/,
    )?.[0];
    expect(afterHoursInsert).toBeTruthy();
    expect(actions).toContain("if (recovery && afterHoursMinutes != null)");
    expect(afterHoursInsert).not.toContain("recovered_from_booking_id");
    expect(afterHoursInsert).not.toContain("recovery_request_fingerprint");
  });

  it("provides an audited, redaction-only privacy exception without changing terminal facts", () => {
    expect(recoveryHardeningMigration).toContain(
      "create or replace function public.redact_terminal_booking_for_privacy(",
    );
    expect(recoveryHardeningMigration).toContain(
      "sa.role in ('founder', 'ops_admin')",
    );
    expect(recoveryHardeningMigration).toContain("verified_erasure_request");
    expect(recoveryHardeningMigration).not.toContain("trim(p_reason)");
    expect(recoveryHardeningMigration).toContain(
      "privacy redaction may only remove allowlisted customer identifiers",
    );
    expect(recoveryHardeningMigration).toContain("client_name = '[removed]'");
    expect(recoveryHardeningMigration).toContain(
      "stripe_payment_intent_id = null",
    );
    expect(recoveryHardeningMigration).toContain(
      "square_payment_link_id = null",
    );
    expect(recoveryHardeningMigration).toContain(
      "terminal_booking_privacy_redacted",
    );
    expect(recoveryHardeningMigration).toContain("terminalHistoryRetained");
    expect(recoveryHardeningMigration).toContain(
      "v_existing_actor_user_id is distinct from p_actor_user_id",
    );
    expect(recoveryHardeningMigration).toContain(
      "v_existing_related_requires_workflow",
    );
    expect(recoveryHardeningMigration).toContain(
      "returning id into v_audit_id",
    );
    expect(recoveryHardeningMigration).toMatch(
      /revoke all on function public\.redact_terminal_booking_for_privacy\([\s\S]*?\) from public, anon, authenticated/i,
    );
    expect(recoveryHardeningMigration).toMatch(
      /grant execute on function public\.redact_terminal_booking_for_privacy\([\s\S]*?\) to service_role/i,
    );
  });
});
