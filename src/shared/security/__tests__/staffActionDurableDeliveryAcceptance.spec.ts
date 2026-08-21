import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

const migrationCandidates = readdirSync(resolve(root, "supabase/migrations"))
  .filter((name) => name.endsWith(".sql") && name > "20260821003000")
  .map((name) => ({
    name,
    text: source(`supabase/migrations/${name}`),
  }));

const notificationRuntimeSources = readdirSync(
  resolve(root, "src/shared/notifications"),
)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({
    name,
    text: source(`src/shared/notifications/${name}`),
  }));

function durableMigration() {
  const candidate = migrationCandidates.find(({ text }) =>
    /staff[_ -]action/i.test(text) &&
    /dispatch[_ -]envelope/i.test(text) &&
    /lease/i.test(text) &&
    /reconcile/i.test(text)
  );
  expect(
    candidate,
    "a strictly-later durable staff-action envelope migration must exist",
  ).toBeDefined();
  return candidate?.text ?? "";
}

function durableWorker() {
  const candidate = notificationRuntimeSources.find(({ text }) =>
    /staff[_ -]action/i.test(text) &&
    /dispatchEnvelope|dispatch_envelope/.test(text) &&
    /lease_due|leaseDue/.test(text)
  );
  expect(
    candidate,
    "a staff-action worker must lease immutable dispatch envelopes",
  ).toBeDefined();
  return candidate?.text ?? "";
}

describe("durable scheduled staff-action notification acceptance", () => {
  it("MQA-0095/0096/0103/0153/0154/0157 binds occurrence, actor, event and exact notify choices", () => {
    const migration = durableMigration();

    expect(migration).toMatch(/request[_ ]id/i);
    expect(migration).toMatch(/actor_user_id/i);
    expect(migration).toMatch(/actor_role/i);
    expect(migration).toMatch(/event/i);
    expect(migration).toMatch(/create/i);
    expect(migration).toMatch(/reschedule/i);
    expect(migration).toMatch(/cancel/i);
    expect(migration).toMatch(/send_after/i);
    expect(migration).toMatch(/(sms_requested|requested_sms|channels[^\n]*sms)/i);
    expect(migration).toMatch(/(email_requested|requested_email|channels[^\n]*email)/i);
    expect(migration).toMatch(/UNIQUE[^;]*(request[_ ]id|occurrence)/i);
    expect(migration).toMatch(/(request|material|occurrence)_conflict/i);
  });

  it("keeps a reschedule valid when the actor explicitly requests neither channel", () => {
    const migration = durableMigration();
    const wrapper = migration.slice(
      migration.indexOf("CREATE FUNCTION public.reschedule_booking_sequence_for_desk("),
      migration.indexOf("REVOKE ALL ON FUNCTION public.staff_action_notification_caller_is_service_role"),
    );
    const firstStaffActionSetting = wrapper.indexOf(
      "set_config('nailiq.staff_action_request_id'",
    );

    expect(wrapper).toMatch(
      /IF\s+\(?\s*coalesce\(p_notify_(sms|email),false\)[\s\S]{0,120}\bOR\b[\s\S]{0,120}coalesce\(p_notify_(email|sms),false\)[\s\S]{0,160}\bTHEN\b/i,
    );
    expect(wrapper.indexOf("IF")).toBeLessThan(firstStaffActionSetting);
  });

  it("stores one immutable, fingerprinted provider envelope for every requested SMS and email operation", () => {
    const migration = durableMigration();

    expect(migration).toMatch(/channel[^\n]*(sms|email)[^\n]*(sms|email)/i);
    expect(migration).toMatch(/dispatch_envelope/i);
    expect(migration).toMatch(/payload_fingerprint/i);
    expect(migration).toMatch(/recipient_fingerprint/i);
    expect(migration).toMatch(/digest\([^;]*(sha256|sha-256)/i);
    expect(migration).toMatch(/octet_length\(dispatch_envelope\)/i);
    expect(migration).toContain(
      "prevent_staff_action_notification_envelope_update",
    );
    expect(migration).toMatch(
      /BEFORE UPDATE ON public\.staff_action_notification_envelopes/i,
    );
  });

  it("claims before either provider and replays only the exact leased envelope", () => {
    const worker = durableWorker();
    const combinedRuntime = notificationRuntimeSources
      .map(({ text }) => text)
      .join("\n");

    expect(worker).toMatch(/attemptToken|attempt_token|leaseToken|lease_token/);
    expect(worker).toMatch(/dispatchEnvelope|dispatch_envelope/);
    expect(worker).toMatch(/payloadFingerprint|payload_fingerprint/);
    expect(worker).toMatch(/recipientFingerprint|recipient_fingerprint/);
    expect(worker).not.toContain('.from("bookings")');
    expect(worker).not.toContain('.from("salons")');
    expect(combinedRuntime).toContain("sendSmsReminder");
    expect(combinedRuntime).toMatch(/emails\.send|sendEmailEnvelope/);
    expect(combinedRuntime).toMatch(/channel[^\n]*(sms|email)/i);
  });

  it("treats response loss as unknown and never makes an automatic resend eligible", () => {
    const migration = durableMigration();

    expect(migration).toMatch(/stale[_ ]sending[_ ]outcome[_ ]unknown/i);
    expect(migration).toMatch(/outcome_unknown/i);
    expect(migration).toMatch(/retryable/i);
    expect(migration).toMatch(/FOR UPDATE SKIP LOCKED/i);
    expect(migration).toMatch(
      /status='unknown',completed_at=v_now,[\s\S]{0,180}failure_disposition='none',next_attempt_at=NULL/i,
    );
  });

  it("MQA-0159 preserves an auditable claim, retry, unknown and provider-receipt trail", () => {
    const migration = durableMigration();

    expect(migration).toContain("staff_action_notification_deliveries");
    expect(migration).toContain("provider_message_id");
    expect(migration).toContain("error_code");
    expect(migration).toContain("completion_fingerprint");
    expect(migration).toContain("reconciliation_reason");
    expect(migration).toContain("inspect_staff_action_notification_event");
  });

  it("drains a bounded staff-action batch independently of the legacy backlog", () => {
    const cron = source("src/app/api/cron/send-pending-notifications/route.ts");

    expect(cron).toMatch(/runStaffAction\w*Worker/);
    expect(cron).toMatch(/STAFF_ACTION\w*BATCH\s*=\s*\d+/);
    const workerIndex = cron.indexOf("runStaffAction");
    const legacyIndex = cron.indexOf('from("scheduled_notifications")');
    expect(workerIndex).toBeGreaterThanOrEqual(0);
    expect(legacyIndex < 0 || workerIndex < legacyIndex).toBe(true);
    expect(cron).not.toContain(
      '.update({ status: "sent", sent_at: new Date().toISOString() }',
    );
  });

  it("moves every scheduled producer and undo path behind durable occurrence capture", () => {
    const edit = source("src/shared/dashboard/editBookingCore.ts");
    const desk = source("src/shared/dashboard/receptionistActions.ts");
    const refund = source("src/shared/payments/deskCancelRefundSaga.ts");
    const producers = `${edit}\n${desk}`;

    expect(producers).not.toMatch(/from\(["']scheduled_notifications["']/);
    expect(desk).toContain(
      "create_public_booking_for_desk_with_staff_notification",
    );
    expect(desk).toContain(
      "cancel_booking_group_for_desk_with_staff_notification",
    );
    expect(refund).toContain(
      "cancel_booking_with_deposit_refund_saga_for_desk",
    );
    expect(producers).toMatch(
      /staff_action_notification_request_id|staffActionNotification/i,
    );
    expect(producers).toMatch(/actor(UserId|_user_id)/);
    expect(producers).toMatch(/actor(Role|_role)/);
    expect(producers).toMatch(/notify(Sms|_sms)/);
    expect(producers).toMatch(/notify(Email|_email)/);

    const deskCreate = desk.slice(
      desk.indexOf("export async function addDeskAppointment"),
    );
    expect(deskCreate).toMatch(
      /create_public_booking_for_desk_with_staff_notification[\s\S]{0,2600}p_idempotency_key:\s*requestId/,
    );
    expect(deskCreate).toMatch(/p_actor_user_id:\s*ctxActorUserId\(ctx\)/);
    expect(deskCreate).toMatch(/p_notify_email:\s*notifyCreateEmail/);
    expect(deskCreate).toMatch(/p_notify_sms:\s*notifyCreateSms/);
    const createReplay = deskCreate.slice(
      deskCreate.indexOf("if (existing)"),
      deskCreate.indexOf("// Plan-tier booking cap"),
    );
    expect(createReplay).toMatch(
      /inspect_staff_action_notification_event|create_public_booking_for_desk_with_staff_notification/,
    );
    expect(createReplay).toMatch(/requested_channels|notify(Create)?(Sms|Email)/);

    const groupCancel = desk.slice(
      desk.indexOf("export async function cancelDeskGroup"),
      desk.indexOf("export async function approveWixBooking"),
    );
    expect(groupCancel).toMatch(
      /cancel_booking_group_for_desk_with_staff_notification[\s\S]{0,1800}p_request_id:\s*requestId/,
    );
    expect(groupCancel).toMatch(
      /p_actor_user_id:\s*(?:ctxActorUserId\(ctx\)|memberActorId)/,
    );
    expect(groupCancel).toMatch(/p_notify_email:\s*notifyEmail/);
    expect(groupCancel).toMatch(/p_notify_sms:\s*notifySms/);

    expect(refund).toMatch(
      /cancel_booking_with_deposit_refund_saga_for_desk[\s\S]{0,1400}p_saga_request_id:\s*input\.requestId/,
    );
    expect(refund).toMatch(/p_actor_user_id:\s*input\.actorUserId/);
    expect(refund).toMatch(/p_notify_email:\s*input\.notifyEmail/);
    expect(refund).toMatch(/p_notify_sms:\s*input\.notifySms/);

    const singleCancel = desk.slice(
      desk.indexOf("export async function cancelDeskBooking"),
      desk.indexOf("export async function requestDepositLink"),
    );
    const singleCancelReplay = singleCancel.slice(
      singleCancel.indexOf("// Replay the immutable outbox receipt"),
      singleCancel.indexOf("const cancellationDb"),
    );
    expect(singleCancelReplay).toMatch(/requested_channels/);
    expect(singleCancelReplay).toMatch(/actor_user_id/);
    expect(singleCancelReplay).toMatch(/notification_delay_seconds/);
  });

  it("does not also dispatch a desk create through the booking-confirmation jobs", () => {
    const desk = source("src/shared/dashboard/receptionistActions.ts");
    const reconciliation = desk.slice(
      desk.indexOf("function scheduleDeskBookingReconciliation"),
      desk.indexOf("export async function addDeskAppointment"),
    );

    expect(reconciliation).not.toContain("/api/booking/sms-confirm");
    expect(reconciliation).not.toContain("/api/booking-email");
  });

  it("fails closed for demo-cookie actions before any provider-bound occurrence is captured", () => {
    const desk = source("src/shared/dashboard/receptionistActions.ts");
    const edit = desk.slice(
      desk.indexOf("export async function editBooking"),
      desk.indexOf("export async function addWalkinAndAssign"),
    );
    const singleCancel = desk.slice(
      desk.indexOf("export async function cancelDeskBooking"),
      desk.indexOf("export async function requestDepositLink"),
    );
    const groupCancel = desk.slice(
      desk.indexOf("export async function cancelDeskGroup"),
      desk.indexOf("export async function approveWixBooking"),
    );
    const deskCreate = desk.slice(
      desk.indexOf("export async function addDeskAppointment"),
    );

    expect(edit).toMatch(
      /ctx\.kind\s*===\s*["']demo_cookie["'][\s\S]{0,160}notify:\s*\{\s*sms:\s*false,\s*email:\s*false\s*\}/,
    );
    expect(singleCancel).toMatch(
      /ctx\.kind\s*===\s*["']member["'][\s\S]{0,600}(notifySms|notificationRequested)/,
    );
    expect(groupCancel).toMatch(
      /ctx\.kind\s*===\s*["']member["'][\s\S]{0,600}(notifySms|notificationRequested)/,
    );
    expect(deskCreate).toMatch(
      /deskNotificationActorId\s*=\s*ctx\.kind\s*===\s*["']member["']/,
    );
  });

  it("cannot collide with booking-confirmation or customer-transition delivery identities", () => {
    const migration = durableMigration();
    const bookingEnvelope = source(
      "supabase/migrations/20260821003000_add_immutable_booking_confirmation_dispatch_envelopes.sql",
    );
    const customerTransition = source(
      "supabase/migrations/20260820131500_add_customer_booking_transition_email_outbox.sql",
    );

    expect(migration).not.toMatch(
      /INSERT INTO public\.booking_confirmation_dispatch_envelopes/i,
    );
    expect(migration).not.toMatch(
      /INSERT INTO public\.customer_booking_transition_email_outbox/i,
    );
    expect(migration).toMatch(/kind[^\n]*staff_action/i);
    expect(migration).not.toMatch(/notification_type[^\n]*booking_confirmation/i);
    expect(bookingEnvelope).toContain("booking_confirmation_dispatch_envelopes");
    expect(customerTransition).toContain(
      "customer_booking_transition_email_outbox",
    );
  });

  it("keeps the new tables and all delivery RPCs service-only", () => {
    const migration = durableMigration();

    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/REVOKE ALL[^;]*FROM public,\s*anon,\s*authenticated/i);
    expect(migration).toMatch(/GRANT (SELECT|EXECUTE)[^;]*TO service_role/i);
    expect(migration).toMatch(/SECURITY DEFINER/i);
    expect(migration).toMatch(/SET search_path TO ''/i);
  });
});
