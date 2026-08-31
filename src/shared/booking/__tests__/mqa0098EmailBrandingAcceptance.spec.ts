import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildEmailBrandHeader,
  normalizeEmailLogoUrl,
} from "@/shared/booking/emailBranding";
import {
  buildBookingConfirmationSubject,
  buildHtml,
} from "@/shared/booking/sendBookingConfirmationEmail";
import {
  buildGroupBookingConfirmationSubject,
  buildGroupBookingConfirmationHtml,
  type AuthoritativeGroupConfirmationReceipt,
} from "@/shared/booking/sendGroupBookingConfirmationEmail";
import { parseGroupBookingPricingQuote } from "@/shared/booking/groupBookingPricing";
import {
  buildGroupReminderEmailSubject,
  buildGroupReminderEmailHtml,
  buildReminderEmailSubject,
  buildReminderEmailHtml,
  type GroupReminderEmailInput,
  type ReminderEmailInput,
} from "@/shared/noshow/sendReminderEmail";
import {
  buildCustomerBookingTransitionEmailPayload,
  type CustomerBookingTransitionMaterial,
} from "@/shared/notifications/customerBookingTransitionEmail";

const SUPABASE_ORIGIN = "https://project-ref.supabase.co";
const APPROVED_LOGO =
  `${SUPABASE_ORIGIN}/storage/v1/object/public/salon-imports/` +
  "11111111-1111-4111-8111-111111111111/logo/logo-1.png";
const SALON_ID = "11111111-1111-4111-8111-111111111111";
const BOOKING_1 = "22222222-2222-4222-8222-222222222221";
const BOOKING_2 = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_ORIGIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MQA-0098 approved salon-logo boundary", () => {
  it("accepts only the configured project's public salon-imports object URL", () => {
    expect(normalizeEmailLogoUrl(APPROVED_LOGO)).toBe(APPROVED_LOGO);

    for (const rejected of [
      "https://tracker.example.test/open.gif",
      `${SUPABASE_ORIGIN}/storage/v1/object/public/booking-photos/customer.png`,
      "https://other-project.supabase.co/storage/v1/object/public/salon-imports/salon/logo.png",
      `${SUPABASE_ORIGIN}/storage/v1/object/sign/salon-imports/salon/logo.png?token=secret`,
      `${SUPABASE_ORIGIN}/storage/v1/object/public/salon-imports/%2e%2e/customer.png`,
      "http://project-ref.supabase.co/storage/v1/object/public/salon-imports/salon/logo.png",
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      `https://user:secret@project-ref.supabase.co/storage/v1/object/public/salon-imports/salon/logo.png`,
      "x".repeat(2_049),
    ]) {
      expect(normalizeEmailLogoUrl(rejected), rejected).toBeNull();
    }
  });

  it("fails closed when the configured Storage origin is unavailable", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(normalizeEmailLogoUrl(APPROVED_LOGO)).toBeNull();
  });

  it("keeps escaped salon text visible even when a valid image is blocked or fails to load", () => {
    const html = buildEmailBrandHeader({
      salonName: 'Salon Ánh Dương & <Friends> "QA"',
      logoUrl: APPROVED_LOGO,
      subtitle: "Booking <Confirmed>",
    });

    expect(html).toContain(`<img src="${APPROVED_LOGO}"`);
    expect(html).toContain(
      ">Salon Ánh Dương &amp; &lt;Friends&gt; &quot;QA&quot;</span>",
    );
    expect(html).toContain("Booking &lt;Confirmed&gt;");
    expect(html).not.toContain("<Friends>");
    expect(html).not.toContain("Booking <Confirmed>");
  });

  it.each([null, "", "not a url", "https://tracker.example.test/pixel.gif"])(
    "uses the escaped salon-name fallback for missing or invalid logo %s",
    (logoUrl) => {
      const html = buildEmailBrandHeader({
        salonName: "Tiệm Mai & <Linh>",
        logoUrl,
        subtitle: "Confirmed",
      });
      expect(html).not.toContain("<img");
      expect(html).toContain(">Tiệm Mai &amp; &lt;Linh&gt;</span>");
    },
  );
});

function groupReceipt(): AuthoritativeGroupConfirmationReceipt {
  const rawMembers = [0, 1].map((memberIndex) => ({
    member_index: memberIndex,
    service_id: `service-${memberIndex}`,
    staff_id: `staff-${memberIndex}`,
    start_time_utc: `2099-08-2${memberIndex + 1}T17:00:00.000Z`,
    end_time_utc: `2099-08-2${memberIndex + 1}T18:00:00.000Z`,
    addon_service_ids: [],
    addon_lines: [],
    first_addon_id: null,
    trailing_buffer_minutes: 0,
    promo_id: null,
    promo_name: null,
    original_price_cents: 5_000,
    promo_discount_cents: 0,
    email_discount_cents: 0,
    service_pre_voucher_cents: 5_000,
    addon_pre_voucher_cents: 0,
    pre_voucher_subtotal_cents: 5_000,
    voucher_discount_cents: 0,
    price_cents: 5_000,
    addon_price_cents: 0,
    subtotal_cents: 5_000,
    tax_cents: 0,
    tax_amount_cents: 0,
    total_cents: 5_000,
    tax_breakdown: [],
  }));
  const pricing = parseGroupBookingPricingQuote({
    success: true,
    code: "booked",
    pricing_fingerprint: "a".repeat(64),
    salon_id: SALON_ID,
    group_size: 2,
    currency: "CAD",
    voucher_id: null,
    original_price_cents: 10_000,
    promo_discount_cents: 0,
    email_discount_cents: 0,
    voucher_discount_cents: 0,
    pre_voucher_subtotal_cents: 10_000,
    subtotal_cents: 10_000,
    tax_cents: 0,
    tax_amount_cents: 0,
    total_cents: 10_000,
    tax_breakdown: [],
    member_quotes: rawMembers,
  });
  if (!pricing) throw new Error("invalid group pricing fixture");
  return {
    organizerBookingId: BOOKING_1,
    organizerName: "Mai <Admin>",
    organizerEmail: "mai@example.test",
    organizerLocale: "vi",
    groupId: "33333333-3333-4333-8333-333333333333",
    shopSlug: "salon-qa",
    salonId: SALON_ID,
    salonName: "Tiệm Mai & Linh",
    salonLogoUrl: APPROVED_LOGO,
    salonTimezone: "America/Vancouver",
    salonAddress: null,
    salonReplyEmail: null,
    pricing,
    members: [
      {
        bookingId: BOOKING_1,
        clientName: "Mai <Admin>",
        serviceName: "Gel <script>",
        staffName: "Anna & Bee",
        pricing: pricing.memberQuotes[0],
      },
      {
        bookingId: BOOKING_2,
        clientName: "Linh & Co",
        serviceName: "Spa > Care",
        staffName: 'Bao "B"',
        pricing: pricing.memberQuotes[1],
      },
    ],
  };
}

function transitionMaterial(locale: "en" | "vi", kind: "cancel" | "reschedule"):
  CustomerBookingTransitionMaterial {
  return {
    outboxId: "33333333-3333-4333-8333-333333333333",
    eventType: kind,
    transitionVersion: 7,
    occurrenceKey: "7".repeat(64),
    status: "pending",
    recipientFingerprint: "a".repeat(64),
    materialFingerprint: "b".repeat(64),
    payloadFingerprint: null,
    snapshot: {
      recipientEmail: "mai@example.test",
      locale,
      clientName: "Mai <Admin>",
      serviceId: "44444444-4444-4444-8444-444444444444",
      serviceName: "Gel <script>",
      staffId: "55555555-5555-4555-8555-555555555555",
      staffName: "Anna & Bee",
      salonName: "Tiệm Mai & Linh",
      salonSlug: "tiem-mai-linh",
      salonTimezone: "America/Vancouver",
      salonLogoUrl: APPROVED_LOGO,
      salonPhone: "+16045550101",
      previousStatus: "confirmed",
      currentStatus: kind === "cancel" ? "cancelled" : "confirmed",
      previousStartTimeUtc: "2099-08-20T17:00:00.000Z",
      newStartTimeUtc: "2099-08-21T18:30:00.000Z",
      transitionedAt: "2099-08-20T16:00:00.000Z",
    },
  };
}

describe("MQA-0098 current customer-email renderers", () => {
  it("escapes individual confirmation branding and customer-controlled display text", () => {
    const html = buildHtml(
      "Tiệm Mai & Linh",
      {
        bookingId: BOOKING_1,
        shopSlug: "salon-qa",
        clientName: "Mai <Admin>",
        clientEmail: "mai@example.test",
        clientLocale: "vi",
        serviceName: "Gel <script>",
        staffName: "Anna & Bee",
        startTimeUtc: "2099-08-20T17:00:00.000Z",
        totalPriceCents: 5_000,
      },
      "Friday <night>",
      "https://nailiq.ca/booking/status?token=safe",
      "CAD",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      APPROVED_LOGO,
    );
    expect(html).toContain(`<img src="${APPROVED_LOGO}"`);
    expect(html).toContain('<html lang="vi">');
    expect(html).toContain("Lịch hẹn đã xác nhận");
    expect(html).toContain("Mai &lt;Admin&gt;");
    expect(html).toContain("Gel &lt;script&gt;");
    expect(html).toContain("Anna &amp; Bee");
    expect(html).not.toContain("<script>");
  });

  it("escapes authoritative group confirmation branding and every member row", () => {
    const html = buildGroupBookingConfirmationHtml(groupReceipt());
    expect(html).toContain(`<img src="${APPROVED_LOGO}"`);
    expect(html).toContain('<html lang="vi">');
    expect(html).toContain("Lịch hẹn nhóm đã xác nhận");
    expect(html).toContain("Mai &lt;Admin&gt;");
    expect(html).toContain("Gel &lt;script&gt;");
    expect(html).toContain("Anna &amp; Bee");
    expect(html).toContain("Bao &quot;B&quot;");
    expect(html).not.toContain("<script>");
  });

  it("escapes individual and consolidated group reminder display text", () => {
    const individual: ReminderEmailInput = {
      salonId: SALON_ID,
      confirmToken: "confirm&value",
      rescheduleToken: "reschedule&value",
      cancelToken: "cancel&value",
      clientName: "Mai <Admin>",
      clientEmail: "mai@example.test",
      locale: "vi",
      serviceName: "Gel <script>",
      staffName: "Anna & Bee",
      startTimeUtc: "2099-08-20T17:00:00.000Z",
      salonName: "Tiệm Mai & Linh",
      salonSlug: "salon-qa",
      salonLogoUrl: APPROVED_LOGO,
    };
    const individualHtml = buildReminderEmailHtml(
      individual,
      "Hi <img onerror=alert(1)>",
    );
    expect(individualHtml).toContain(`<img src="${APPROVED_LOGO}"`);
    expect(individualHtml).toContain('<html lang="vi">');
    expect(individualHtml).toContain("Nhắc lịch hẹn");
    expect(individualHtml).toContain("Gel &lt;script&gt;");
    expect(individualHtml).toContain("Hi &lt;img onerror=alert(1)&gt;");
    expect(individualHtml).not.toContain("<script>");

    const group: GroupReminderEmailInput = {
      confirmToken: "confirm",
      rescheduleToken: "reschedule",
      cancelToken: "cancel",
      organizerName: "Mai <Admin>",
      organizerEmail: "mai@example.test",
      locale: "vi",
      salonName: "Tiệm Mai & Linh",
      salonSlug: "salon-qa",
      reminderType: "24h",
      salonLogoUrl: APPROVED_LOGO,
      members: [{
        name: "Linh <Guest>",
        serviceName: "Spa & Care",
        staffName: 'Bao "B"',
        startTimeUtc: "2099-08-20T17:00:00.000Z",
        status: "confirmed",
      }],
    };
    const groupHtml = buildGroupReminderEmailHtml(group);
    expect(groupHtml).toContain(`<img src="${APPROVED_LOGO}"`);
    expect(groupHtml).toContain('<html lang="vi">');
    expect(groupHtml).toContain("Nhắc lịch hẹn nhóm");
    expect(groupHtml).toContain("Mai &lt;Admin&gt;");
    expect(groupHtml).toContain("Linh &lt;Guest&gt;");
    expect(groupHtml).toContain("Spa &amp; Care");
  });

  it.each([
    ["en", "reschedule", "Appointment Rescheduled"],
    ["en", "cancel", "Appointment Cancelled"],
    ["vi", "reschedule", "Lịch hẹn đã được dời"],
    ["vi", "cancel", "Lịch hẹn đã huỷ"],
  ] as const)(
    "renders localized %s %s branding with escaped snapshot text",
    (locale, kind, subtitle) => {
      const payload = buildCustomerBookingTransitionEmailPayload(
        kind,
        transitionMaterial(locale, kind),
      );
      expect(payload?.html).toContain(`html lang="${locale}"`);
      expect(payload?.html).toContain(`<img src="${APPROVED_LOGO}"`);
      expect(payload?.html).toContain(subtitle);
      expect(payload?.html).toContain("Gel &lt;script&gt;");
      expect(payload?.html).not.toContain("<script>");
    },
  );
});

describe("MQA-0098 channel wiring and bilingual contract", () => {
  const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

  it.each([
    ["en", "Booking Confirmed"],
    ["vi", "Lịch hẹn đã xác nhận"],
  ] as const)("renders individual confirmation brand copy in %s", (clientLocale, subtitle) => {
    const html = buildHtml(
      "Salon QA",
      {
        bookingId: BOOKING_1,
        shopSlug: "salon-qa",
        clientName: "Mai",
        clientEmail: "mai@example.test",
        clientLocale,
        serviceName: "Gel",
        staffName: "Anna",
        startTimeUtc: "2099-08-20T17:00:00.000Z",
        totalPriceCents: 5_000,
      },
      "time",
      "https://nailiq.ca/booking/status?token=safe",
      "CAD",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      APPROVED_LOGO,
    );
    expect(html).toContain(`<html lang="${clientLocale}">`);
    expect(html).toContain(subtitle);
    expect(buildBookingConfirmationSubject("Salon QA", clientLocale)).toBe(
      clientLocale === "vi"
        ? "Lịch hẹn đã xác nhận — Salon QA"
        : "Booking confirmed — Salon QA",
    );
  });

  it.each([
    ["en", "Group Booking Confirmed"],
    ["vi", "Lịch hẹn nhóm đã xác nhận"],
  ] as const)("renders group confirmation brand copy in %s", (organizerLocale, subtitle) => {
    const html = buildGroupBookingConfirmationHtml({ ...groupReceipt(), organizerLocale });
    expect(html).toContain(`<html lang="${organizerLocale}">`);
    expect(html).toContain(subtitle);
    expect(buildGroupBookingConfirmationSubject("Salon QA", organizerLocale)).toBe(
      organizerLocale === "vi"
        ? "Lịch hẹn nhóm đã xác nhận — Salon QA"
        : "Group booking confirmed — Salon QA",
    );
  });

  it.each([
    ["en", "Appointment Reminder"],
    ["vi", "Nhắc lịch hẹn"],
  ] as const)("renders individual reminder brand copy in %s", (locale, subtitle) => {
    const html = buildReminderEmailHtml({
      salonId: SALON_ID,
      confirmToken: "confirm",
      rescheduleToken: "reschedule",
      cancelToken: "cancel",
      clientName: "Mai",
      clientEmail: "mai@example.test",
      locale,
      serviceName: "Gel",
      staffName: "Anna",
      startTimeUtc: "2099-08-20T17:00:00.000Z",
      salonName: "Salon QA",
      salonSlug: "salon-qa",
      salonLogoUrl: APPROVED_LOGO,
    }, "Safe body");
    expect(html).toContain(`<html lang="${locale}">`);
    expect(html).toContain(subtitle);
    expect(buildReminderEmailSubject({ locale, serviceName: "Gel", salonName: "Salon QA" }))
      .toBe(locale === "vi" ? "Nhắc lịch: Gel tại Salon QA" : "Reminder: your Gel at Salon QA");
    expect(buildGroupReminderEmailSubject({ locale, members: [{
      name: "Mai", serviceName: "Gel", staffName: "Anna",
      startTimeUtc: "2099-08-20T17:00:00.000Z", status: "confirmed",
    }], salonName: "Salon QA" }))
      .toBe(locale === "vi"
        ? "Nhắc lịch: Lịch hẹn nhóm (1 người) tại Salon QA"
        : "Reminder: Group appointment (party of 1) at Salon QA");
  });

  it("wires persisted/caller locale into every confirmation and reminder producer", () => {
    expect(source("src/shared/booking/submitPublicBooking.ts"))
      .toContain("clientLocale: params.language ?? \"en\"");
    const receptionist = source("src/shared/dashboard/receptionistActions.ts");
    expect(receptionist).toContain("clientLocale: input.language ?? existing.client_locale");
    expect(receptionist).toContain("clientLocale: input.language ?? null");
    const group = source("src/shared/booking/sendGroupBookingConfirmationEmail.ts");
    expect(group).toContain("client_email, client_locale,");
    expect(group).toContain("organizerLocale: normalizeEmailLocale(organizer.client_locale)");
    const reminders = source("src/app/api/cron/reminders/route.ts");
    expect(reminders).toContain("client_email, client_locale, status");
    expect(reminders.match(/locale: .*client_locale/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("routes every current customer transactional renderer through the shared brand header", () => {
    for (const file of [
      "src/shared/booking/sendBookingConfirmationEmail.ts",
      "src/shared/booking/sendGroupBookingConfirmationEmail.ts",
      "src/shared/noshow/sendReminderEmail.ts",
    ]) {
      const contents = source(file);
      expect(contents, file).toContain("buildEmailBrandHeader");
    }
    for (const file of [
      "src/shared/notifications/customerBookingTransitionEmail.ts",
      "src/shared/notifications/deliverStaffActionNotification.ts",
      "src/shared/notifications/staffActionNotificationEnvelope.ts",
    ]) {
      expect(source(file), file).toContain("buildCustomerAppointmentEmail");
    }
    expect(source("src/shared/notifications/staffActionEmailTemplate.ts"))
      .toContain("buildEmailBrandHeader");
    expect(source("src/shared/noshow/sendReminderEmail.ts").match(/buildEmailBrandHeader\(/g))
      .toHaveLength(2);
  });

});
