import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  groupBookingCreateRequestSchema,
  groupBookingQuoteRequestSchema,
} from "../groupBookingPricingServer";
import {
  parseSequenceBookingIntent,
  parseSequenceTimingSegments,
  serializeSequenceBookingIntent,
} from "../bookingSequence";
import { publicBookingQuoteRequestSchema } from "../publicBookingQuoteServer";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const registry = read("src/shared/features/featureRegistry.ts");
const voiceExecutor = read("src/shared/voiceai/toolExecutor.ts");
const sequenceFlow = read("src/components/booking/BookingSequenceFlow.tsx");
const bookingSwitcher = read("src/components/booking/BookingTypeSwitcher.tsx");
const publicBookingPage = read("src/app/[slug]/page.tsx");
const readiness = read("src/shared/dashboard/loadGoLiveReadiness.ts");
const sequenceReschedule = read("src/shared/booking/bookingSequenceReschedule.ts");
const deskEdit = read("src/shared/dashboard/editBookingCore.ts");
const sequenceBehavior = read("scripts/security/rehearse-booking-service-sequence.sql");
const sequenceConcurrency = read(
  "scripts/security/rehearse-booking-service-sequence-concurrency.mjs",
);
const sequenceBoundary = read("scripts/security/check-booking-service-sequence-boundary.sql");
const migrationDir = resolve(root, "supabase/migrations");
const migrationSql = readdirSync(migrationDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(resolve(migrationDir, name), "utf8"))
  .join("\n");

const salonId = "11111111-1111-4111-8111-111111111111";
const serviceId = "22222222-2222-4222-8222-222222222222";
const secondServiceId = "33333333-3333-4333-8333-333333333333";
const staffId = "44444444-4444-4444-8444-444444444444";
const requestId = "55555555-5555-4555-8555-555555555555";
const lineId = "66666666-6666-4666-8666-666666666666";

function publicQuoteInput() {
  return {
    salonId,
    serviceId,
    resolvedStaffId: staffId,
    startTimeUtc: "2026-08-28T18:00:00.000Z",
    endTimeUtc: "2026-08-28T19:00:00.000Z",
    addonServiceIds: [],
    clientPhone: "16045550199",
    clientEmail: null,
    applyEmailDiscount: false,
  };
}

function groupMember(index: number) {
  return {
    serviceId,
    staffId,
    startTimeUtc: `2026-08-28T${18 + index}:00:00.000Z`,
    endTimeUtc: `2026-08-28T${19 + index}:00:00.000Z`,
    addonServiceIds: [],
    clientName: index === 0 ? "Organizer" : "Guest",
    clientPhone: index === 0 ? "16045550199" : null,
  };
}

describe("multi-service/prep Phase-A pre-implementation safety boundary", () => {
  it("does not silently coerce sequence-shaped public input into the legacy single-service quote", () => {
    expect(publicBookingQuoteRequestSchema.safeParse({
      ...publicQuoteInput(),
      serviceIds: [serviceId, secondServiceId],
    }).success).toBe(false);
    expect(publicBookingQuoteRequestSchema.safeParse({
      ...publicQuoteInput(),
      lines: [
        { lineId: crypto.randomUUID(), serviceId, position: 0 },
        { lineId: crypto.randomUUID(), serviceId: secondServiceId, position: 1 },
      ],
    }).success).toBe(false);
  });

  it("keeps Group Phase A one-main-service-per-member and rejects extra sequence material", () => {
    const bookings = [groupMember(0), groupMember(1)];
    expect(groupBookingQuoteRequestSchema.safeParse({
      salonId,
      bookings: [
        { ...bookings[0], lines: [{ serviceId }, { serviceId: secondServiceId }] },
        bookings[1],
      ],
    }).success).toBe(false);
    expect(groupBookingCreateRequestSchema.safeParse({
      salonId,
      bookings,
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
      expectedPricingFingerprint: "a".repeat(64),
      lines: [{ serviceId }, { serviceId: secondServiceId }],
    }).success).toBe(false);
  });

  it("allows only an absent or fully dormant Beta registry entry before rollout", () => {
    const hasFeature = registry.includes('multi_service_booking: {');
    if (!hasFeature) {
      expect(registry).not.toContain('"multi_service_booking"');
      expect(registry).not.toContain('flagKey: "multi_service_booking_enabled"');
      return;
    }
    expect(registry).toMatch(/multi_service_booking:\s*\{[\s\S]{0,500}?phase:\s*"beta"/);
    expect(registry).toMatch(/multi_service_booking:\s*\{[\s\S]{0,500}?defaultOn:\s*false/);
    expect(registry).toMatch(/multi_service_booking:\s*\{[\s\S]{0,500}?source:\s*\{\s*kind:\s*"jsonb",\s*flagKey:\s*"multi_service_booking_enabled"/);
  });

  it("keeps the staged DB contract complete and inaccessible until the bounded API surface lands", () => {
    const routePresent = existsSync(resolve(root, "src/app/api/booking/sequence-quote/route.ts"));
    const hasQuoteRpc = /quote_public_booking_sequence\s*\(/.test(migrationSql);
    const hasCreateRpc = /create_public_booking_sequence\s*\(/.test(migrationSql);
    const hasSegments = /CREATE TABLE(?: IF NOT EXISTS)? public\.booking_service_segments\b/i.test(migrationSql);
    const hasPrep = /ALTER TABLE public\.services[\s\S]{0,500}?\bprep_minutes\b/i.test(migrationSql);
    expect([hasQuoteRpc, hasCreateRpc, hasSegments, hasPrep]).toEqual([
      true,
      true,
      true,
      true,
    ]);

    expect(migrationSql).toMatch(/ALTER TABLE public\.booking_service_segments ENABLE ROW LEVEL SECURITY/i);
    expect(migrationSql).toMatch(/REVOKE ALL ON FUNCTION public\.quote_public_booking_sequence\(jsonb\)\s+FROM PUBLIC, anon, authenticated/i);
    expect(migrationSql).toMatch(/REVOKE ALL ON FUNCTION public\.create_public_booking_sequence\(jsonb\)\s+FROM PUBLIC, anon, authenticated/i);
    expect(migrationSql).toMatch(/GRANT EXECUTE ON FUNCTION public\.quote_public_booking_sequence\(jsonb\)\s+TO service_role/i);
    expect(migrationSql).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_public_booking_sequence\(jsonb\)\s+TO service_role/i);
    if (!routePresent) {
      expect(registry).toContain("CONTROLLED_ROLLOUT_RELEASE_FLAG_KEYS");
      expect(registry).toContain('"multi_service_booking_enabled"');
      expect(registry).toMatch(
        /multi_service_booking:[\s\S]{0,420}?defaultOn:\s*false/,
      );
    }
  });

  it("exposes the sequence UI only through authoritative readiness and keeps Voice fail closed", () => {
    expect(publicBookingPage).toContain("loadPublicBookingSequenceReadiness");
    expect(publicBookingPage).toContain("sequenceReadiness?.ok === true");
    expect(bookingSwitcher).toContain("multiServiceSequenceEnabled");
    expect(bookingSwitcher).toContain("<BookingSequenceFlow");
    expect(sequenceFlow).toContain("/api/booking/sequence-quote");
    expect(sequenceFlow).toContain("/api/booking/sequence-create");
    expect(readiness).toContain("load_public_booking_sequence_readiness");
    expect(voiceExecutor).toContain("multi_service_not_supported");
  });
});

describe("locked multi-service/prep acceptance — enable only after seams land", () => {
  it("strict sequence parser accepts 1..5 ordered UUID lines and rejects extra keys, duplicate line IDs, noncontiguous positions, and browser money/timing", () => {
    const raw = {
      salonId,
      requestId,
      requestedStartTimeUtc: "2026-08-28T18:00:00.000Z",
      lines: [{
        lineId,
        position: 0,
        serviceId,
        staffPreference: "any",
        preferredResourceId: null,
        addOnServiceIds: [],
      }],
      sameStaffForAll: false,
      applyEmailDiscount: false,
      customer: { name: "QA Guest", phone: "+16045550199", email: null },
    };
    const parsed = parseSequenceBookingIntent(raw);
    expect(parsed).not.toBeNull();
    expect(Object.keys(serializeSequenceBookingIntent(parsed!)).sort()).toEqual([
      "apply_email_discount",
      "contract_version",
      "customer",
      "lines",
      "request_id",
      "requested_start_time_utc",
      "salon_id",
      "same_staff_for_all",
      "voucher_code",
    ]);
    expect(parseSequenceBookingIntent({ ...raw, totalCents: 1 })).toBeNull();
    expect(parseSequenceBookingIntent({
      ...raw,
      lines: [{ ...raw.lines[0], prepMinutes: 5 }],
    })).toBeNull();
    expect(parseSequenceBookingIntent({
      ...raw,
      lines: [raw.lines[0], { ...raw.lines[0], position: 1 }],
    })).toBeNull();
    expect(parseSequenceBookingIntent({
      ...raw,
      lines: [raw.lines[0], { ...raw.lines[0], lineId: requestId, position: 2 }],
    })).toBeNull();
  });

  it("pure timing parser enforces prep/service/buffer equations and rejects customer-work overlap", () => {
    const first = {
      line_id: lineId,
      position: 0,
      service_id: serviceId,
      resolved_staff_id: staffId,
      resolved_resource_id: null,
      prep_minutes: 10,
      duration_minutes: 30,
      buffer_minutes: 5,
      occupied_start_utc: "2026-08-28T17:50:00.000Z",
      service_start_utc: "2026-08-28T18:00:00.000Z",
      service_end_utc: "2026-08-28T18:30:00.000Z",
      occupied_end_utc: "2026-08-28T18:35:00.000Z",
    };
    const second = {
      ...first,
      line_id: requestId,
      position: 1,
      service_id: secondServiceId,
      prep_minutes: 5,
      occupied_start_utc: "2026-08-28T18:25:00.000Z",
      service_start_utc: "2026-08-28T18:30:00.000Z",
      service_end_utc: "2026-08-28T19:00:00.000Z",
      occupied_end_utc: "2026-08-28T19:05:00.000Z",
    };
    expect(parseSequenceTimingSegments([first, second])).toHaveLength(2);
    expect(parseSequenceTimingSegments([
      first,
      {
        ...second,
        occupied_start_utc: "2026-08-28T18:15:00.000Z",
        service_start_utc: "2026-08-28T18:20:00.000Z",
        service_end_utc: "2026-08-28T18:50:00.000Z",
        occupied_end_utc: "2026-08-28T18:55:00.000Z",
      },
    ])).toBeNull();
  });

  it("rehearses shifts, breaks, one-off unavailability, opening/DST, resources, and same-staff intersection", () => {
    expect(sequenceBehavior).toContain("five-line DST quote invalid");
    expect(sequenceBehavior).toContain("sequence local close was not enforced");
    expect(sequenceBehavior).toContain("closed Sunday did not override DST/open hours");
    expect(sequenceBehavior).toContain("staff one-off unavailability not enforced");
    expect(sequenceBehavior).toContain("outside-shift sequence was accepted");
    expect(sequenceBehavior).toContain("staff-break crossing sequence was accepted");
    expect(sequenceBehavior).toContain("break-adjacent non-overlap sequence was rejected");
    expect(sequenceBehavior).toContain("split capability mappings created a false common staff");
    expect(sequenceBehavior).toContain("valid common-staff intersection was not enforced");
    expect(sequenceConcurrency).toContain("Same resource/different staff race");
  });

  it("rehearses pricing fingerprint drift and separate create replay identity", () => {
    for (const marker of [
      "line order/service sequence missing from pricing fingerprint",
      "staff preference/assignment missing from pricing fingerprint",
      "resource preference/assignment missing from pricing fingerprint",
      "requested start missing from pricing fingerprint",
      "add-ons missing from pricing fingerprint",
      "voucher allocation missing from pricing fingerprint",
      "contact leaked into pricing fingerprint separation",
      "derived prep timing missing from pricing fingerprint",
      "contract version did not fail closed",
      "changed replay was accepted",
    ]) {
      expect(sequenceBehavior).toContain(marker);
    }
  });
  it("rehearses one-line sequence parity against the canonical individual resolver", () => {
    expect(sequenceBehavior).toContain("Flag-on one-line parity");
    expect(sequenceBehavior).toContain("public.resolve_public_booking_pricing");
    for (const field of [
      "original_price_cents",
      "pre_voucher_subtotal_cents",
      "subtotal_cents",
      "tax_cents",
      "total_cents",
    ]) {
      expect(sequenceBehavior).toContain(field);
    }
    expect(sequenceBehavior).toContain("one-line sequence create failed");
  });

  it("provides the public build/reorder/review/reconfirm/receipt journey without restoring price", () => {
    expect(sequenceFlow).toContain("+ Add service");
    expect(sequenceFlow).toContain("setLines((current) =>");
    expect(sequenceFlow).toContain("addOnServiceIds");
    expect(sequenceFlow).toContain("sameStaffForAll");
    expect(sequenceFlow).toContain('setStage("review")');
    expect(sequenceFlow).toContain("Back to edit");
    expect(sequenceFlow).toContain("Confirm updated price");
    expect(sequenceFlow).toContain("setQuote(result.quote)");
    expect(sequenceFlow).toContain("sessionStorage.getItem");
    expect(sequenceFlow).not.toMatch(
      /sessionStorage\.setItem[\s\S]{0,500}?(quote|pricingFingerprint|totalCents)/,
    );
  });

  it("locks segment ACL/exclusions, replay, rollback, voucher and cross-model races in rehearsals", () => {
    expect(sequenceBoundary).toContain("segment RLS/table ACL boundary mismatch");
    expect(sequenceBoundary).toContain("booking_service_segments_staff_no_overlap");
    expect(sequenceBoundary).toContain("booking_service_segments_resource_no_overlap");
    expect(sequenceBehavior).toContain("changed replay was accepted");
    expect(sequenceBehavior).toContain("pricing change did not fail with zero writes");
    expect(sequenceBehavior).toContain("segment status did not synchronize");
    expect(sequenceConcurrency).toContain("same staff/capacity");
    expect(sequenceConcurrency).toContain("Same resource/different staff race");
    expect(sequenceConcurrency).toContain("voucher_invalid");
    expect(sequenceConcurrency).toContain("PASS booking service sequence concurrency");
  });

  it("binds desk actor/notify choice through first apply, exact replay, and changed-notify rejection", () => {
    expect(sequenceReschedule).toContain("reschedule_booking_sequence_for_desk");
    expect(sequenceReschedule).toContain("p_notify_email: input.notifyEmail");
    expect(sequenceReschedule).toContain("p_notify_sms: input.notifySms");
    expect(deskEdit).toContain("rescheduleBookingSequenceForDesk");
    expect(deskEdit).toContain("const sequenceNotifySms = (input.notify?.sms ?? true) === true");
    expect(deskEdit).toContain(
      "The DB sequence wrapper captured both requested staff-action channels",
    );
    expect(deskEdit).not.toContain("deliverCustomerBookingTransitionEmail");
    expect(sequenceBehavior).toContain("desk actor/notification contract failed");
    expect(sequenceBehavior).toContain("desk exact response-loss replay failed");
    expect(sequenceBehavior).toContain("desk changed notify replay was not rejected");
    expect(sequenceBehavior).toContain("customer_transition_email_requested");
    expect(sequenceBehavior).toContain("customer_transition_sms_requested");
  });

  it("rehearses atomic full-sequence reschedule, rollback, replay, conflict, and stable lines", () => {
    expect(sequenceBehavior).toContain("forced sequence reschedule did not roll back every write");
    expect(sequenceBehavior).toContain("atomic full-sequence reschedule failed");
    expect(sequenceBehavior).toContain("sequence reschedule exact replay drifted");
    expect(sequenceBehavior).toContain("changed sequence reschedule replay accepted");
    expect(sequenceBehavior).toContain("sequence slot race was not zero-write");
    expect(sequenceBehavior).toContain("five-line repeated-service reschedule failed");
  });
});

describe("sequence DB/app contract adversarial acceptance", () => {
  it("keeps quote/create on the exact nested browser contract and persists stable line IDs", () => {
    const createStart = migrationSql.indexOf(
      "CREATE OR REPLACE FUNCTION public.create_public_booking_sequence",
    );
    expect(createStart).toBeGreaterThan(-1);
    const createSql = migrationSql.slice(createStart);

    expect(createSql).toMatch(/v_customer\s*:=\s*p_request->'customer'/);
    expect(createSql).toMatch(/v_digits\s*:=\s*pg_catalog\.regexp_replace\([\s\S]{0,160}?v_customer->>'phone'/);
    expect(createSql).toMatch(/v_voucher_code\s*:=\s*nullif\(upper\(trim\(coalesce\(p_request->>'voucher_code'/);
    expect(migrationSql).toMatch(/'line_id',\s*v_line_id/);
    expect(createSql).toMatch(/INSERT INTO public\.booking_service_segments\s*\([\s\S]{0,240}?\bline_id\b/);
    expect(createSql).toMatch(/v_segment->>'line_id'/);
  });

  it("enforces authoritative staff shift, break, and unavailability truth before quoting", () => {
    const resolverStart = migrationSql.indexOf(
      "CREATE OR REPLACE FUNCTION public.resolve_booking_sequence_pricing_and_schedule",
    );
    const resolverEnd = migrationSql.indexOf(
      "CREATE OR REPLACE FUNCTION public.quote_public_booking_sequence",
      resolverStart,
    );
    const resolverSql = migrationSql.slice(resolverStart, resolverEnd);
    expect(resolverSql).toContain("public.staff_shifts");
    expect(resolverSql).toContain("break_start_time");
    expect(resolverSql).toContain("public.staff_unavailability");
  });

  it("installs transaction-serialized cross-model staff/resource capacity protection", () => {
    expect(migrationSql).toContain("enforce_booking_capacity_across_models");
    expect(migrationSql).toContain("booking-capacity:staff:");
    expect(migrationSql).toContain("booking-capacity:resource:");
    expect(migrationSql).toMatch(/FROM public\.bookings b[\s\S]{0,800}?FROM public\.booking_service_segments seg/);
    expect(migrationSql).toContain("booking_service_segments_staff_no_overlap");
    expect(migrationSql).toContain("booking_service_segments_resource_no_overlap");
  });

  it("allocates the one-time email discount to zero-based line 0 for one-line parity", () => {
    const resolverStart = migrationSql.indexOf(
      "CREATE OR REPLACE FUNCTION public.resolve_booking_sequence_pricing_and_schedule",
    );
    const resolverEnd = migrationSql.indexOf(
      "CREATE OR REPLACE FUNCTION public.quote_public_booking_sequence",
      resolverStart,
    );
    const resolverSql = migrationSql.slice(resolverStart, resolverEnd);
    const allocations = [...resolverSql.matchAll(
      /position'\)::integer = (\d+) THEN v_email/g,
    )].map((match) => Number(match[1]));
    expect(allocations.length).toBeGreaterThanOrEqual(4);
    expect(new Set(allocations)).toEqual(new Set([0]));
  });

  it("requires platform, salon, catalog, capacity, and payment-policy readiness together", () => {
    const readinessStart = migrationSql.lastIndexOf(
      "CREATE OR REPLACE FUNCTION public.load_public_booking_sequence_readiness",
    );
    const readinessEnd = migrationSql.indexOf(
      "REVOKE ALL ON FUNCTION public.load_public_booking_sequence_readiness",
      readinessStart,
    );
    const readinessSql = migrationSql.slice(readinessStart, readinessEnd + 300);
    expect(readinessStart).toBeGreaterThan(-1);
    expect(readinessSql).toContain("feature_multi_service_booking");
    expect(readinessSql).toContain("multi_service_booking_enabled");
    expect(readinessSql).toContain("multi_service_booking_qa_salon_id");
    expect(readinessSql).toContain("qa_allowlisted");
    expect(readinessSql).toContain("payment_policy_ready");
    expect(readinessSql).toContain("booking_sequence_payment_policy_ready");
    expect(migrationSql).toMatch(
      /booking_sequence_payment_policy_ready[\s\S]{0,1800}?deposit_enabled[\s\S]{0,300}?access_token[\s\S]{0,300}?application_id/,
    );
    expect(migrationSql).toContain(
      "pg_catalog.jsonb_typeof(s.cancellation_policy) = 'object'",
    );
    expect(migrationSql).toContain(
      "(s.cancellation_policy ->> 'en') !~ '\\[[^]]+\\]'",
    );
    expect(readinessSql).toMatch(
      /'ready',\s*v_platform AND coalesce\(v_salon, false\)[\s\S]{0,120}?coalesce\(v_qa_allowlisted, false\)[\s\S]{0,120}?coalesce\(v_catalog, false\) AND coalesce\(v_capacity, false\)[\s\S]{0,120}?coalesce\(v_payment_policy, false\)/,
    );
    expect(readinessSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.load_public_booking_sequence_readiness\(uuid\)[\s\S]{0,120}?FROM PUBLIC, anon, authenticated/,
    );
  });

  it("replays an exact create from persisted request/pricing material before re-resolving availability", () => {
    const createStart = migrationSql.indexOf(
      "CREATE OR REPLACE FUNCTION public.create_public_booking_sequence",
    );
    const readinessStart = migrationSql.indexOf(
      "CREATE OR REPLACE FUNCTION public.load_public_booking_sequence_readiness",
      createStart,
    );
    const createSql = migrationSql.slice(createStart, readinessStart);
    const existingRead = createSql.indexOf("SELECT b.* INTO v_existing");
    const replayReturn = createSql.indexOf(
      "RETURN v_existing.public_booking_pricing_snapshot",
      existingRead,
    );
    const liveResolve = createSql.indexOf(
      "v_quote := public.resolve_booking_sequence_pricing_and_schedule",
    );
    expect(existingRead).toBeGreaterThan(-1);
    expect(replayReturn).toBeGreaterThan(existingRead);
    expect(liveResolve).toBeGreaterThan(replayReturn);
    expect(createSql).toContain("public_booking_request_fingerprint IS DISTINCT FROM v_request_fingerprint");
    expect(createSql).toContain("public_booking_pricing_fingerprint IS DISTINCT FROM v_expected_fingerprint");
    expect(createSql).toMatch(
      /v_quote_fingerprint IS DISTINCT FROM v_expected_fingerprint[\s\S]{0,180}?'pricing_changed'/,
    );
  });
});
