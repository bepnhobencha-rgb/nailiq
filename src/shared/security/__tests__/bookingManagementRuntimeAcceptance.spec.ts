import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const exists = (relative: string) => fs.existsSync(path.join(ROOT, relative));

function migrationCorpus(): string {
  const dir = path.join(ROOT, "supabase/migrations");
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
    .filter((sql) => /booking_management_capabilities/i.test(sql))
    .join("\n");
}

function sources(files: string[]): string {
  return files.map(read).join("\n");
}

function requirePattern(source: string, pattern: RegExp, label: string): void {
  expect(pattern.test(source), label).toBe(true);
}

function forbidPattern(source: string, pattern: RegExp, label: string): void {
  expect(pattern.test(source), label).toBe(false);
}

const migration = migrationCorpus();
const confirmPage = read("src/app/booking/confirm/page.tsx");
const confirmRoute = read("src/app/api/booking/confirm-action/route.ts");
const statusRoute = read("src/app/api/booking/status/route.ts");
const waitlistPage = read("src/app/booking/waitlist-claim/page.tsx");
const waitlistButton = read("src/app/booking/waitlist-claim/WaitlistClaimButton.tsx");
const waitlistBoundary = read("src/shared/booking/waitlistClaim.ts");
const publicWaitPage = read("src/app/[slug]/wait/[bookingId]/page.tsx");
const walkinWaitLink = sources([
  "src/components/receptionist/WalkinQueueSidebar.tsx",
  "src/components/receptionist/ReceptionistCenter.tsx",
]);
const cancelRoute = read("src/app/api/booking/cancel-action/route.ts");
const rescheduleRoute = read("src/app/api/booking/reschedule-action/route.ts");
const slotsRoute = read("src/app/api/booking/reschedule-slots/route.ts");
const cardRoutes = sources([
  "src/app/api/booking/save-card-context/route.ts",
  "src/app/api/booking/card-info/route.ts",
  "src/app/api/booking/remove-card/route.ts",
  "src/app/api/booking/square-save-card/route.ts",
  "src/app/api/booking/stripe-setup-intent/route.ts",
]);
const cardPageAndCapture = sources([
  "src/app/booking/save-card/page.tsx",
  "src/app/booking/card/page.tsx",
  "src/components/booking/NoShowCardCapture.tsx",
]);
const groupRsvp = sources([
  "src/app/booking/group-rsvp/page.tsx",
  "src/shared/booking/groupMemberRsvpActions.ts",
]);
const tokenGenerator = read("src/shared/noshow/generateReminderToken.ts");
const confirmationEmail = read("src/shared/booking/sendBookingConfirmationEmail.ts");
const reminderEmail = read("src/shared/noshow/sendReminderEmail.ts");
const reminderCron = read("src/app/api/cron/reminders/route.ts");
const requestIds = read("src/shared/booking/bookingManagementRequestId.ts");
const boundedJsonReader = read("src/shared/security/readJsonObjectWithLimit.ts");
const nextConfig = read("next.config.ts");
const waitlistLinkGenerators = sources([
  "src/shared/noshow/promoteAndDeliverWaitlistOffer.ts",
  "src/app/api/cron/waitlist-advance/route.ts",
  "src/app/api/twilio/inbound/route.ts",
  "src/shared/dashboard/receptionistActions.ts",
]);
const promotedWaitlistDelivery = read("src/shared/noshow/deliverPromotedWaitlistOffer.ts");
const waitlistCapabilityMigration = read("supabase/migrations/20260820143000_add_action_scoped_waitlist_claim_capabilities.sql");
const bookingManagementRehearsal = read("scripts/security/rehearse-booking-management-capabilities.sql");
const waitlistClaimRehearsal = read("scripts/security/rehearse-waitlist-claim-capabilities.sql");

describe("MQA-0099 fixed local boundaries", () => {
  it("PASS_LOCAL: confirmation GET only inspects and explicit bounded same-origin POST consumes", () => {
    expect(exists("src/app/api/booking/confirm-action/route.ts")).toBe(true);
    forbidPattern(confirmPage, /confirm_booking_as_customer/, "confirmation page still mutates directly");
    requirePattern(confirmPage, /method:\s*["']POST["']/, "confirmation page must POST");
    requirePattern(confirmPage, /stableBookingManagementRequestId/, "confirmation needs stable request id");
    requirePattern(confirmRoute, /expectedAction:\s*["']confirm["']/, "GET must inspect confirm scope");
    requirePattern(confirmRoute, /isSameOriginMutation/, "POST needs exact-origin fence");
    requirePattern(confirmRoute, /readJsonObjectWithLimit\(\s*request\s*,\s*1024\s*\)/, "POST needs an actual-stream body cap");
    requirePattern(boundedJsonReader, /getReader\(\)[\s\S]*total\s*>\s*maxBytes/, "shared reader does not enforce an actual byte cap");
    requirePattern(confirmRoute, /confirmBookingWithManagementCapability/, "POST needs atomic capability RPC");
  });

  it("PASS_LOCAL: status is action-scoped and emits a PII-free snapshot", () => {
    requirePattern(statusRoute, /expectedAction:\s*["']status["']/, "status scope missing");
    requirePattern(statusRoute, /inspectBookingManagementCapability/, "status must use capability inspection");
    forbidPattern(statusRoute, /client_name|client_phone|client_email/i, "status response exposes client PII");
  });

  it("PASS_LOCAL: scanner GET cannot confirm or claim a waitlist slot", () => {
    requirePattern(confirmRoute, /export async function GET[\s\S]*inspectBookingManagementCapability/, "confirm GET is not inspection-only");
    forbidPattern(waitlistPage, /claim_waitlist_slot|claimWaitlistSlot/, "waitlist page GET can claim");
    requirePattern(waitlistPage, /loadWaitlistClaimPreview/, "waitlist page needs read-only preview");
    requirePattern(waitlistButton, /method:\s*["']POST["']/, "waitlist needs explicit POST button");
    requirePattern(waitlistBoundary, /inspect_waitlist_claim_capability/, "waitlist preview should use the PII-free inspection RPC");
    forbidPattern(waitlistBoundary, /select\([^)]*client_(?:name|phone|email)/, "preview reads unnecessary PII");
  });

  it("PASS_LOCAL: naked booking-id wait URL neither loads state nor mints authority", () => {
    forbidPattern(publicWaitPage, /loadCustomerWaitState\s*\(/, "naked booking id loads private state");
    forbidPattern(publicWaitPage, /generateReminderToken\s*\(/, "naked booking id mints authority");
    requirePattern(publicWaitPage, /statusToken|managementToken/, "legacy redirect requires existing capability");
  });

  it("PASS_LOCAL: link generators mint independent action capabilities", () => {
    requirePattern(tokenGenerator, /mintBookingManagementCapability/, "generator is not capability-backed");
    requirePattern(tokenGenerator, /confirm[\s\S]*reschedule[\s\S]*cancel[\s\S]*status[\s\S]*card_manage/, "independent action set incomplete");
    requirePattern(reminderEmail, /confirmToken[\s\S]*rescheduleToken[\s\S]*cancelToken/, "reminder email scopes missing");
    requirePattern(reminderCron, /confirmToken[\s\S]*rescheduleToken/, "reminder SMS scopes missing");
    requirePattern(confirmationEmail, /action:\s*["']status["'][\s\S]*action:\s*["']reschedule["'][\s\S]*action:\s*["']cancel["']/, "confirmation links are not independently minted");
  });

  it("PASS_LOCAL: DB capability contract binds tenant/action/epoch and exact replay atomically", () => {
    requirePattern(migration, /booking_management_capabilities/, "capability table missing");
    requirePattern(migration, /salon_id[\s\S]*booking_id[\s\S]*action/, "tenant/action binding missing");
    requirePattern(migration, /request_id/, "request id missing");
    requirePattern(migration, /payload_fingerprint/, "payload fingerprint missing");
    requirePattern(migration, /result_json/, "durable result missing");
    requirePattern(migration, /FOR UPDATE/i, "consume does not lock");
    requirePattern(migration, /idempotency_mismatch/, "changed replay is not rejected");
    requirePattern(migration, /expires_at\s*<=\s*(?:transaction_timestamp\(\)|v_now)/i, "atomic expiry check missing");
    requirePattern(migration, /revoked_at\s+IS\s+NOT\s+NULL/i, "atomic revocation check missing");
  });

  it("PASS_LOCAL: token pages and capability APIs are private/no-referrer/noindex", () => {
    requirePattern(nextConfig, /source:\s*["']\/booking\/:path\*["']/, "booking token page rule missing");
    requirePattern(nextConfig, /key:\s*["']Cache-Control["'],\s*value:\s*["']private, no-store/, "booking token page cache header missing");
    requirePattern(nextConfig, /key:\s*["']Referrer-Policy["'],\s*value:\s*["']no-referrer["']/, "booking token page referrer header missing");
    requirePattern(nextConfig, /key:\s*["']X-Robots-Tag["'],\s*value:\s*["']noindex, nofollow["']/, "booking token page robots header missing");
    for (const route of [confirmRoute, statusRoute]) {
      requirePattern(route, /Cache-Control["',: ]+private, no-store/, "capability API cache header missing");
      requirePattern(route, /Referrer-Policy["',: ]+no-referrer/, "capability API referrer header missing");
      requirePattern(route, /X-Robots-Tag["',: ]+noindex, nofollow/, "capability API robot header missing");
    }
    expect(exists("src/app/booking/layout.tsx")).toBe(true);
  });

  it("PASS_LOCAL: browser replay IDs are stable and do not store raw tokens", () => {
    requirePattern(requestIds, /SHA-256/, "storage key must hash capability material");
    requirePattern(requestIds, /sessionStorage\.getItem/, "stable replay read missing");
    requirePattern(requestIds, /sessionStorage\.setItem/, "stable replay write missing");
    forbidPattern(requestIds, /sessionStorage\.setItem\([^,]+,\s*intent\.token/, "raw token stored in browser");
  });

  it("PASS_LOCAL: relevant capability handlers do not log bearer tokens", () => {
    const corpus = sources([
      "src/app/api/booking/confirm-action/route.ts",
      "src/app/api/booking/status/route.ts",
      "src/app/api/booking/waitlist-claim/route.ts",
      "src/shared/booking/bookingManagementCapabilities.ts",
      "src/shared/booking/waitlistClaim.ts",
    ]);
    forbidPattern(corpus, /console\.(?:log|warn|error)\([^\n]*(?:token|request\.url)/i, "capability secret may enter logs");
  });

  it("PASS_LOCAL: cancel/reschedule/slot routes consume scoped capabilities with stable replay", () => {
    const mutationRoutes = cancelRoute + rescheduleRoute;
    forbidPattern(mutationRoutes + slotsRoute, /booking_reminder_tokens/, "new tokens cannot resolve through the legacy table");
    forbidPattern(mutationRoutes, /cancel_booking_as_customer_with_transition_email|reschedule_booking_as_customer_with_transition_email/, "legacy consume RPC remains");
    requirePattern(cancelRoute, /cancelBookingWithManagementCapability[\s\S]*requestId/, "cancel atomic replay wiring missing");
    requirePattern(rescheduleRoute, /rescheduleBookingWithManagementCapability[\s\S]*requestId/, "reschedule atomic replay wiring missing");
    requirePattern(slotsRoute, /expectedAction:\s*["']reschedule["']/, "slot read accepts wrong action");
  });

  it("PASS_LOCAL: cancellation replay uses persisted policy and reports an existing charge truthfully", () => {
    forbidPattern(cancelRoute, /if\s*\(preview\?\.willCharge/, "consumed-token replay silently skips the late-cancel charge");
    requirePattern(cancelRoute, /committed\.cancelPreview[\s\S]*chargeNoShowFee/, "durable cancellation result lacks fee reconciliation material");
    requirePattern(cancelRoute, /feeStatus\s*=\s*charged\.status/, "authoritative payment status is discarded");
    requirePattern(cancelRoute, /feeCharged\s*=\s*charged\.status\s*===\s*["']succeeded["']/, "a succeeded first attempt or exact replay is misreported as uncharged");
    requirePattern(cancelRoute, /feeStatus\s*===\s*["']pending_provider["'][\s\S]*feeStatus\s*===\s*["']unknown["']/, "ambiguous provider truth is collapsed into a definite result");
  });

  it("PASS_LOCAL: promoted waitlist sends are claimed per offer/channel and exact receipts are enforced", () => {
    requirePattern(cancelRoute + rescheduleRoute, /deliverPromotedWaitlistOffer/, "transition route bypasses durable offer delivery");
    requirePattern(promotedWaitlistDelivery, /claim_waitlist_offer_delivery/, "provider send lacks durable preclaim");
    requirePattern(promotedWaitlistDelivery, /complete_waitlist_offer_delivery/, "provider result lacks durable completion");
    requirePattern(promotedWaitlistDelivery, /\^\(SM\|MM\)\[0-9a-fA-F\]\{32\}\$/, "SMS accepted status lacks exact Twilio receipt validation");
    requirePattern(waitlistCapabilityMigration, /channel='sms' AND provider_receipt~'\^\(SM\|MM\)\[0-9a-fA-F\]\{32\}\$'/, "DB accepts malformed SMS receipts");
    requirePattern(waitlistCapabilityMigration, /status IN \('sent','failed','unknown','suppressed'\)/, "unknown/suppressed terminal truth missing");
  });

  it("PASS_LOCAL: receptionist wait links mint a status capability instead of exposing a naked booking id", () => {
    forbidPattern(walkinWaitLink, /\/wait\/\$\{target\.id\}/, "receptionist still emits naked booking-id wait link");
    requirePattern(walkinWaitLink, /onCreateWaitLink[\s\S]*mintBookingStatusLink/, "receptionist wait link does not mint a status capability");
  });

  it("PASS_LOCAL: reschedule persists policy truth and promotes against the exact freed old slot", () => {
    requirePattern(migration, /ELSIF\s+p_expected_action='reschedule'[\s\S]{0,2600}v_cancel_preview\s*:=\s*public\.booking_management_cancel_preview/i, "reschedule result leaves cancel_preview null");
    requirePattern(rescheduleRoute, /committed\.cancelPreview[\s\S]*policyLockedByReschedule/, "reschedule audit is not based on the durable snapshot");
    requirePattern(migration, /promote_waitlist_for_freed_slot\([\s\S]{0,500}v_booking\.staff_id\s*,\s*v_old_start\s*,\s*v_old_end\s*,\s*20\s*\)/i, "management mutation does not pass the exact freed staff/start/end to canonical promotion");
    requirePattern(waitlistCapabilityMigration, /CREATE OR REPLACE FUNCTION public\.promote_waitlist_for_freed_slot[\s\S]{0,1800}offered_staff_id=CASE[\s\S]{0,180}p_offered_staff_id[\s\S]{0,220}offered_start_utc=CASE[\s\S]{0,180}p_offered_start_utc/i, "canonical promotion does not persist the freed slot receipt");
  });

  it("PASS_LOCAL: waitlist capability links inspect and claim with bounded stable replay", () => {
    forbidPattern(waitlistBoundary, /\.eq\(["']claim_token["']|claim_waitlist_slot/, "new capability link is resolved as a legacy entry token");
    requirePattern(waitlistBoundary, /inspect_waitlist_claim_capability/, "GET preview does not inspect the scoped capability");
    requirePattern(waitlistBoundary, /claim_waitlist_with_management_capability/, "POST does not use atomic capability claim");
    requirePattern(waitlistButton, /stableBookingManagementRequestId[\s\S]*requestId/, "waitlist response-loss replay has no stable request id");
    const waitlistRoute = read("src/app/api/booking/waitlist-claim/route.ts");
    requirePattern(waitlistRoute, /content-length[\s\S]*1024/i, "waitlist body lacks Content-Length cap");
    requirePattern(waitlistRoute, /getReader[\s\S]*total\s*>\s*1024/i, "waitlist body lacks actual-stream cap");
  });

  it("PASS_LOCAL: stale browser replay entries expire without clearing unknown outcomes early", () => {
    requirePattern(requestIds, /createdAt|expiresAt|ttl|MAX_AGE/i, "sessionStorage replay record has no age");
    requirePattern(requestIds, /purge|cleanup|expired|stale/i, "stale request-id cleanup missing");
  });

  it("PASS_LOCAL: group RSVP uses independent member-own capabilities and stable bounded actions", () => {
    forbidPattern(groupRsvp, /booking_reminder_tokens|confirm_party_member|decline_party_member/, "group RSVP still uses legacy shared token/RPC");
    requirePattern(groupRsvp, /member_own|member_scope/, "member-own scope missing in app");
    requirePattern(groupRsvp, /stableBookingManagementRequestId|requestId/, "group RSVP replay id missing");
    requirePattern(groupRsvp, /suggestedName[\s\S]*(?:slice\(|max\()/, "suggested replacement name is unbounded");
    requirePattern(groupRsvp, /suggestedPhone[\s\S]*(?:slice\(|max\()/, "suggested replacement phone is unbounded");
    requirePattern(groupRsvp, /select\(["'][^"']*attendance_status/, "RSVP load does not read member attendance truth");
    requirePattern(groupRsvp, /row\.attendance_status[\s\S]{0,260}["']pending["']/, "canonical booking status can be mistaken for an explicit RSVP");
    requirePattern(groupRsvp, /currentStatus[\s\S]{0,600}setUiState\(["']idle["']\)/, "pending attendance does not render the idle RSVP controls");
  });

  it("PASS_LOCAL: migrated management surfaces no longer authorize legacy reminder tokens and keep query responses private", () => {
    const legacySurface = cancelRoute + rescheduleRoute + slotsRoute + cardRoutes + groupRsvp;
    forbidPattern(legacySurface, /booking_reminder_tokens/, "legacy shared token still authorizes a production surface");
    for (const route of [cancelRoute, slotsRoute, read("src/app/api/booking/save-card-context/route.ts"), read("src/app/api/booking/card-info/route.ts")]) {
      requirePattern(route, /Cache-Control["',: ]+private, no-store/, "query-token API can be cached");
      requirePattern(route, /Referrer-Policy["',: ]+no-referrer/, "query-token API referrer policy missing");
      requirePattern(route, /X-Robots-Tag["',: ]+noindex, nofollow/, "query-token API robots header missing");
    }
  });
});

describe("MQA-0099 remaining acceptance (intentionally red until wired)", () => {
  it("REMAINING P0: all customer mutation routes are same-origin and body-bounded", () => {
    for (const route of [
      cancelRoute,
      rescheduleRoute,
      read("src/app/api/booking/waitlist-claim/route.ts"),
      read("src/app/api/booking/remove-card/route.ts"),
      read("src/app/api/booking/square-save-card/route.ts"),
      read("src/app/api/booking/stripe-setup-intent/route.ts"),
      read("src/app/api/booking/flag-noshow-card/route.ts"),
    ]) {
      requirePattern(route, /isSameOriginMutation/, "customer mutation lacks exact-origin fence");
      requirePattern(route, /readJsonObjectWithLimit\(\s*(?:req|request)\s*,\s*(?:1024|2048|4096|8192)\s*\)|getReader\(\)[\s\S]*total\s*>\s*(?:1024|2048|4096|8192)/, "customer mutation does not use the actual-stream body cap");
    }
  });

  it("REMAINING P0: a freed slot inside the 20-minute offer window cannot roll back cancel/reschedule", () => {
    requirePattern(migration, /promote_waitlist_for_freed_slot\([\s\S]{0,500}v_old_start\s*,\s*v_old_end\s*,\s*20\s*\)/i, "cancel/reschedule does not delegate freed-slot expiry to canonical promotion");
    requirePattern(waitlistCapabilityMigration, /v_expiry:=CASE WHEN p_offered_start_utc>v_now[\s\S]{0,180}least\(v_now\+make_interval\(mins=>v_window\),p_offered_start_utc\)/i, "near-term claim expiry is not safely bounded by the freed slot");
    requirePattern(bookingManagementRehearsal, /interval\s*'5 minutes'[\s\S]{0,900}cancel_booking_with_management_capability[\s\S]{0,900}promoted_waitlist[\s\S]{0,500}expires_at/i, "no SQL rehearsal proves near-term cancellation still commits with a bounded capability");
    requirePattern(bookingManagementRehearsal, /(?:interval\s*'5 minutes'[\s\S]{0,900}reschedule_booking_with_management_capability|reschedule_booking_with_management_capability[\s\S]{0,900}interval\s*'5 minutes')[\s\S]{0,900}promoted_waitlist/i, "no SQL rehearsal proves near-term reschedule still commits with a bounded capability");
    requirePattern(bookingManagementRehearsal, /promoted_waitlist[\s\S]{0,400}claim_capability_token|claim_capability_token[\s\S]{0,400}promoted_waitlist/i, "rehearsal does not prove there is no notified row without a capability");
  });

  it("REMAINING P0: auto-book failure retires the old offer before a new epoch can deliver", () => {
    requirePattern(waitlistCapabilityMigration, /auto_book_failed[\s\S]{0,900}revoked_at\s*=\s*v_now[\s\S]{0,500}epoch\s*=\s*epoch\+1/i, "failed auto-book leaves its capability/epoch reusable");
    requirePattern(waitlistCapabilityMigration, /auto_book_failed[\s\S]{0,1500}waitlist_offer_delivery_outbox[\s\S]{0,500}(?:unknown|suppressed)/i, "failed auto-book leaves delivery truth pending");
    requirePattern(waitlistClaimRehearsal, /auto_book_failed[\s\S]{0,900}inspect_waitlist_claim_capability\(v_token3\)[\s\S]{0,900}v_token4:?=\(public\.mint_waitlist_claim_capability[\s\S]{0,650}v_token4=v_token3[\s\S]{0,650}offer_epoch=2[\s\S]{0,900}claim_waitlist_offer_delivery/i, "no rehearsal proves old bearer rejection and fresh next delivery");
  });

  it("REMAINING P0: card inspection/removal/provider setup is bound to card_manage, not naked bookingId", () => {
    forbidPattern(cardRoutes, /booking_reminder_tokens/, "card routes still use legacy shared tokens");
    requirePattern(cardRoutes, /expectedAction:\s*["']card_manage["']/, "card_manage scope inspection missing");
    requirePattern(cardPageAndCapture, /managementToken|capabilityToken|cardToken/, "provider capture does not carry capability proof");
    requirePattern(cardRoutes, /requestId/, "card removal/save has no stable response-loss replay id");
    forbidPattern(cardPageAndCapture, /JSON\.stringify\(\{\s*bookingId/, "browser still authorizes provider setup with a naked booking id");
    const squareSaveRoute = read("src/app/api/booking/square-save-card/route.ts");
    const stripeSetupRoute = read("src/app/api/booking/stripe-setup-intent/route.ts");
    requirePattern(squareSaveRoute, /saveCardWithManagementCapability/, "Square provider endpoint bypasses durable card_manage claim");
    requirePattern(stripeSetupRoute, /createStripeSetupWithManagementCapability/, "Stripe provider endpoint bypasses durable card_manage claim");
    for (const route of [squareSaveRoute, stripeSetupRoute]) {
      requirePattern(route, /isSameOriginMutation/, "provider endpoint lacks origin fence");
    }
    requirePattern(read("src/app/api/booking/remove-card/route.ts"), /claim|receipt|idempoten/i, "provider-accepted card removal has no durable replay receipt");
  });

  it("REMAINING P0: every waitlist link generator mints the new capability; raw claim_token links are now dead", () => {
    forbidPattern(waitlistLinkGenerators, /waitlist-claim\?token=\$\{(?:row\.)?claim_token\}|waitlist-claim\?token=\$\{token\}/, "production link exposes legacy entry claim_token");
    requirePattern(waitlistLinkGenerators, /advance_waitlist_offer_capabilities|promote_waitlist_for_booking|promote_waitlist_entry/, "canonical capability-bearing promotion missing from link generators");
  });

  it("REMAINING P1: waitlist invitation delivery is durably claimed per offer and channel", () => {
    requirePattern(waitlistLinkGenerators, /deliverPromotedWaitlistOffer|deliverCanonicalWaitlistPromotion/, "canonical promotions bypass durable delivery");
    requirePattern(promotedWaitlistDelivery, /claim_waitlist_offer_delivery/, "response-loss replay can resend waitlist SMS/email");
    requirePattern(promotedWaitlistDelivery, /complete_waitlist_offer_delivery/, "waitlist provider outcome is not durably finalized");
  });

  it("REMAINING P1: rendered waitlist delivery facts are bound to the claimed material snapshot", () => {
    forbidPattern(promotedWaitlistDelivery, /p_material_fingerprint:\s*materialFingerprint/, "app merely echoes the stored material hash");
    requirePattern(promotedWaitlistDelivery, /render.*fingerprint|authoritative.*fingerprint|material.*snapshot/i, "rendered salon/service/staff facts are not recomputed and bound");
  });

});
