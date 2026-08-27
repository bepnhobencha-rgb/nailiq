import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");
const configRoute = read("src/app/api/booking/square-noshow-config/route.ts");
const squareSaveRoute = read("src/app/api/booking/square-save-card/route.ts");
const stripeSetupRoute = read("src/app/api/booking/stripe-setup-intent/route.ts");
const flagRoute = read("src/app/api/booking/flag-noshow-card/route.ts");
const removeRoute = read("src/app/api/booking/remove-card/route.ts");
const capture = read("src/components/booking/NoShowCardCapture.tsx");
const stripeCapture = read("src/components/booking/NoShowCardCaptureStripe.tsx");
const depositPanel = read("src/components/booking/BookingFlowDepositPanel.tsx");
const groupFlow = read("src/components/booking/BookingGroupFlow.tsx");
const cardPage = read("src/app/booking/card/page.tsx");
const individualCreate = read("src/shared/booking/submitPublicBooking.ts");
const individualCardSettlement = read("src/shared/booking/settleCommittedBookingCardManagement.ts");
const individualFlow = read("src/components/booking/useBookingFlowState.ts");
const individualDone = read("src/components/booking/BookingFlowDonePanel.tsx");
const groupSubmit = read("src/shared/booking/submitGroupBooking.ts");
const groupCreateRoute = read("src/app/api/booking/group-create/route.ts");
const cardCapabilityMigration = read("supabase/migrations/20260820140000_add_action_scoped_booking_management_capabilities.sql");
const cardManagement = read("src/shared/booking/bookingCardManagement.ts");
const cardCapabilityRoute = read("src/app/api/booking/card-capability/route.ts");
const bookingCapabilities = read("src/shared/booking/bookingManagementCapabilities.ts");

function requirePattern(source: string, pattern: RegExp, label: string) {
  expect(pattern.test(source), label).toBe(true);
}

function forbidPattern(source: string, pattern: RegExp, label: string) {
  expect(pattern.test(source), label).toBe(false);
}

describe("card_manage exposure and replay boundary", () => {
  it("does not contact Stripe merely because the public booking bundle was evaluated", () => {
    for (const [label, source] of [
      ["no-show capture", stripeCapture],
      ["deposit panel", depositPanel],
    ] as const) {
      requirePattern(
        source,
        /from ["']@stripe\/stripe-js\/pure["']/,
        `${label} does not use Stripe's deferred-loading entrypoint`,
      );
      forbidPattern(
        source,
        /import\s+(?!type\b)[^;]+from ["']@stripe\/stripe-js["']/,
        `${label} eagerly injects Stripe.js during public-page module evaluation`,
      );
    }
  });

  it("fresh individual and group creation hand the browser a server-minted card_manage capability", () => {
    requirePattern(individualCreate, /cardManage(?:ment)?Token|card_manage_token/, "individual create result omits its card capability");
    requirePattern(individualCreate, /create_public_booking[\s\S]{0,8500}settleCommittedBookingCardManagement/, "individual authoritative create/replay does not hand post-commit card work to the settlement boundary");
    requirePattern(individualCardSettlement, /\/api\/booking\/card-capability[\s\S]{0,1600}cardManagementToken/, "individual settlement does not exchange and return card_manage");
    requirePattern(cardCapabilityRoute + bookingCapabilities, /exchangePublicBookingCardManagementCapability[\s\S]{0,1600}exchange_public_booking_card_management_capability/, "individual exchange is not handled by the trusted server boundary");
    requirePattern(cardCapabilityMigration, /exchange_public_booking_card_management_capability[\s\S]{0,1800}idempotency_key[\s\S]{0,900}pricing_fingerprint[\s\S]{0,1500}mint_booking_management_capability/i, "individual exchange is not bound to the exact canonical create receipt");
    requirePattern(individualFlow, /(?:cardManage(?:ment)?Token|managementToken)/, "individual success UI does not retain the server capability");

    const groupServerBoundary = groupCreateRoute + groupSubmit;
    requirePattern(groupServerBoundary, /cardManage(?:ment)?Token|card_manage_token/, "group create result omits the organizer card capability");
    requirePattern(groupCreateRoute, /mintBookingManagementCapability|card_manage_token/, "group server boundary does not mint or return the organizer capability");
    requirePattern(groupFlow, /(?:cardManage(?:ment)?Token|managementToken)/, "group success UI does not retain the organizer capability");

    const publicMintSurfaces = configRoute + squareSaveRoute + stripeSetupRoute + flagRoute + removeRoute;
    forbidPattern(publicMintSurfaces, /mintBookingManagementCapability[\s\S]{0,500}(?:bookingId|booking_id)/, "a public card endpoint can mint authority from a naked booking id");
  });

  it("all public card endpoints authorize card_manage rather than a naked bookingId", () => {
    requirePattern(configRoute, /expectedAction:\s*["']card_manage["']/, "Square config does not inspect card_manage");
    requirePattern(configRoute, /token/, "Square config has no capability token");
    requirePattern(flagRoute, /route_retired[\s\S]*410|410[\s\S]*route_retired/, "legacy flag route is not safely retired");
    forbidPattern(flagRoute, /ensureNoShowCardRequirement|bookingId/, "retired flag route still trusts or mutates a booking id");
    requirePattern(squareSaveRoute, /saveCardWithManagementCapability/, "Square save bypasses the durable card_manage helper");
    requirePattern(stripeSetupRoute, /createStripeSetupWithManagementCapability/, "Stripe setup bypasses the durable card_manage helper");
    requirePattern(removeRoute, /removeCardWithManagementCapability/, "remove bypasses the durable card_manage helper");
    requirePattern(cardManagement, /claim_booking_card_(?:save|management)_operation/, "card helper does not claim card_manage operations");
    for (const [label, route] of [
      ["Square save", squareSaveRoute],
      ["Stripe setup", stripeSetupRoute],
      ["requirement flag", flagRoute],
      ["remove", removeRoute],
    ] as const) {
      requirePattern(route, /requestId/, `${label} has no stable replay id`);
      requirePattern(route, /isSameOriginMutation/, `${label} lacks same-origin mutation fencing`);
    }
  });

  it("browser card surfaces carry token+stable requestId and never send bookingId alone", () => {
    const surface = capture + stripeCapture + groupFlow + cardPage;
    requirePattern(surface, /stableBookingManagementRequestId/, "card surfaces do not retain replay ids");
    for (const endpoint of ["square-save-card", "stripe-setup-intent", "remove-card"]) {
      const escaped = endpoint.replace(/-/g, "-");
      requirePattern(surface, new RegExp(`${escaped}[\\s\\S]{0,700}(?:token|managementToken)[\\s\\S]{0,300}requestId`), `${endpoint} caller omits capability or replay id`);
    }
    forbidPattern(surface, /fetch\(["']\/api\/booking\/flag-noshow-card/, "browser still calls the retired booking-id flag route");
    forbidPattern(surface, /JSON\.stringify\(\{\s*bookingId\s*\}\)/, "browser authorizes card work with only bookingId");
  });

  it("every card mutation bounds the actual stream even when Content-Length is missing/spoofed", () => {
    for (const [label, route] of [
      ["Square save", squareSaveRoute],
      ["Stripe setup", stripeSetupRoute],
      ["requirement flag", flagRoute],
      ["remove", removeRoute],
    ] as const) {
      requirePattern(route, /getReader|readBoundedJson|readJsonObjectWithLimit/, `${label} trusts Content-Length without bounding the stream`);
      forbidPattern(route, /Number\([^\n]*content-length[^\n]*\)[\s\S]{0,160}(?:<=\s*0|<\s*1)/i, `${label} rejects a valid bounded body only because Content-Length is absent`);
    }
  });

  it("remove-card owns a durable provider attempt and exact response-loss replay", () => {
    const removalBoundary = removeRoute + cardManagement;
    requirePattern(removalBoundary, /claim_booking_card_management_operation|claimBookingCardManagementOperation/, "remove does not claim before provider");
    requirePattern(removalBoundary, /complete_booking_card_management_operation|completeBookingCardManagementOperation/, "remove does not finalize provider truth");
    requirePattern(removalBoundary, /idempotent|already_(?:completed|succeeded)|terminal/, "remove cannot recover an acknowledged durable outcome");
    forbidPattern(removeRoute, /card_removal_unavailable/, "remove is permanently disabled despite the durable DB contract");
  });

  it("Stripe setup is a two-stage durable operation and final save has exact replay", () => {
    requirePattern(cardCapabilityMigration, /provider='stripe'[\s\S]{0,160}mode='setup_intent'[\s\S]{0,2200}finalize_token_id/i, "successful setup does not mint a separate final-save capability");
    requirePattern(cardCapabilityMigration, /mode='save_card'[\s\S]{0,500}setup_not_authorized/i, "final Stripe save is not bound to a completed setup");
    const stripeBoundary = stripeSetupRoute + cardManagement;
    requirePattern(stripeBoundary, /claim_booking_card_save_operation|claimBookingCardSaveOperation/, "Stripe setup is not durably claimed before provider work");
    requirePattern(stripeBoundary, /complete_booking_card_save_operation|completeBookingCardSaveOperation/, "Stripe setup result is not durably finalized");
    requirePattern(stripeCapture + squareSaveRoute, /finalizeToken|finalize_token|managementToken[\s\S]{0,500}sourceId/, "confirmed PaymentMethod save does not use the server-issued final capability");
    requirePattern(stripeCapture + squareSaveRoute, /stableBookingManagementRequestId|requestId/, "final Stripe save has no stable exact-replay id");
    forbidPattern(stripeCapture, /JSON\.stringify\(\{\s*bookingId[\s\S]{0,180}sourceId/, "final Stripe save still authorizes by booking id");
  });

  it("pre-submit card capture follows create replay, deterministic mint, then durable save", () => {
    forbidPattern(individualCreate, /saveNoShowCardAction\s*\(/, "individual create still performs an unaudited post-commit card save");
    requirePattern(individualCreate, /p_idempotency_key[\s\S]{0,8500}settleCommittedBookingCardManagement/, "individual captured card is not sequenced create/replay -> committed-card settlement");
    requirePattern(individualCardSettlement, /card-capability[\s\S]{0,2200}square-save-card/, "individual committed-card settlement does not sequence exchange -> durable save");
    requirePattern(individualCardSettlement, /card-capability[\s\S]{0,900}idempotencyKey:\s*input\.createIdempotencyKey[\s\S]{0,2600}square-save-card[\s\S]{0,900}token:\s*cardManagementToken[\s\S]{0,500}requestId:\s*input\.createIdempotencyKey/, "individual response-loss replay does not preserve create binding and card request id");

    forbidPattern(groupFlow, /JSON\.stringify\(\{\s*bookingId[\s\S]{0,500}(?:sourceId|flag-noshow-card)/, "group browser performs a naked post-create card mutation");
    requirePattern(groupFlow, /noShowCardSourceId:\s*cardTokenRef\.current/, "group UI does not submit its pre-captured source");
    requirePattern(groupSubmit, /cardSourceId:\s*params\.noShowCardSourceId/, "group pre-captured source is not forwarded to the trusted create boundary");
    requirePattern(groupCreateRoute, /createGroupBookingsAuthoritative[\s\S]{0,1800}mintBookingManagementCapability[\s\S]{0,1800}saveCardWithManagementCapability[\s\S]{0,600}requestId:\s*parsed\.data\.idempotencyKey/, "group organizer is not sequenced create/replay -> mint -> durable save with the create key");
    requirePattern(groupCreateRoute, /createGroupBookingsAuthoritative[\s\S]{0,3500}mintBookingManagementCapability/, "group capability can be minted before canonical group create/replay");
  });

  it("keeps a committed booking successful while card reconciliation remains separate", () => {
    forbidPattern(individualCreate, /throw new Error\(["']card_management_pending["']\)/, "post-commit card work can still reverse the booking result");
    forbidPattern(individualFlow, /card_management_pending/, "individual flow still sends a committed booking back to Confirm");
    requirePattern(individualCardSettlement, /card-capability[\s\S]{0,900}idempotencyKey:\s*input\.createIdempotencyKey/, "exchange does not carry the exact create key");
    requirePattern(individualCardSettlement, /square-save-card[\s\S]{0,1300}cardManagementToken:\s*null,[\s\S]{0,120}cardManagementPending:\s*true/, "ambiguous card save does not become a non-retriable pending state");
    forbidPattern(individualCardSettlement, /square-save-card[\s\S]{0,1800}square-save-card/, "ambiguous card save can be blindly dispatched twice");
    requirePattern(cardManagement, /attempt_replay[\s\S]{0,9000}attemptReplay[\s\S]{0,700}reconciliation_required[\s\S]{0,900}resolvePaymentProvider/, "a replayed in-flight card claim can reach the provider before reconciliation");
    requirePattern(individualFlow, /await acknowledgePublicBookingRequestId[\s\S]{0,1600}cardManagementPending:\s*result\.cardManagementPending[\s\S]{0,300}setStep\(["']done["']\)/, "committed booking identity is not acknowledged before the card-pending success view");
    requirePattern(individualFlow, /cardManagementPending:\s*result\.cardManagementPending[\s\S]{0,300}setStep\(["']done["']\)/, "committed booking does not carry card pending into Done");
    requirePattern(individualDone, /booking-card-pending-notice[\s\S]{0,400}cardManagementPendingNotice/, "Done does not explain the card-only pending state");
  });
});
