import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/twilioSms", () => ({
  sendSmsReminder: vi.fn(),
}));
vi.mock("@/shared/lib/resend", () => ({
  getResendClient: () => ({ emails: { send } }),
  getResendFrom: () => "NailIQ <noreply@example.test>",
}));
vi.mock("@/shared/lib/emailCompliance", () => ({
  listUnsubscribeHeaders: () => ({}),
  complianceFooterHtml: ({ lang }: { lang?: string }) => `<footer data-lang="${lang ?? "en"}">footer</footer>`,
  isEmailSuppressed: vi.fn(async () => false),
}));
vi.mock("@/shared/lib/notificationLog", () => ({
  logNotification: vi.fn(async () => undefined),
}));

import { deliverStaffActionNotification } from "../deliverStaffActionNotification";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const BOOKING_ID = "22222222-2222-4222-8222-222222222222";
const LOGO =
  "https://project-ref.supabase.co/storage/v1/object/public/salon-imports/" +
  `${SALON_ID}/logo/logo.png`;

function query(data: unknown) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data, error: null }),
  };
  return chain;
}

function db(defaultLocale: "en" | "vi") {
  const booking = {
    id: BOOKING_ID,
    client_phone: null,
    client_email: "mai@example.test",
    client_name: "Mai <Admin>",
    client_locale: defaultLocale,
    start_time_utc: "2099-08-20T17:00:00.000Z",
    service: { name: "Gel <script>" },
    staff: { name: "Anna & Bee" },
  };
  const salon = {
    name: "Tiệm Mai & Linh",
    phone: "+16045550101",
    timezone: "America/Vancouver",
    default_notification_locale: defaultLocale,
    email_outbound_enabled: true,
    logo_url: LOGO,
  };
  return {
    from: vi.fn((table: string) => query(table === "bookings" ? booking : salon)),
  };
}

describe("MQA-0098 staff-action customer email branding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
    send.mockResolvedValue({ data: { id: "email-1" }, error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders escaped English cancellation branding through the provider payload", async () => {
    const result = await deliverStaffActionNotification(db("en") as never, {
      salonId: SALON_ID,
      bookingId: BOOKING_ID,
      event: "cancel",
      channels: { email: true },
      localeOverride: "en",
    });
    expect(result).toMatchObject({ locale: "en", emailSent: true });
    const payload = send.mock.calls[0]?.[0] as { subject: string; text: string; html: string };
    expect(payload.subject).toBe("Appointment cancelled — Tiệm Mai & Linh");
    expect(payload.html).toContain(`<img src="${LOGO}"`);
    expect(payload.html).toContain("Appointment Cancelled");
    expect(payload.html).toContain("Mai &lt;Admin&gt;");
    expect(payload.html).toContain("Gel &lt;script&gt;");
    expect(payload.html).not.toContain("<script>");
  });

  it("renders a Vietnamese document and Vietnamese brand subtitle for a Vietnamese customer", async () => {
    const result = await deliverStaffActionNotification(db("vi") as never, {
      salonId: SALON_ID,
      bookingId: BOOKING_ID,
      event: "reschedule",
      channels: { email: true },
      localeOverride: "vi",
    });
    expect(result).toMatchObject({ locale: "vi", emailSent: true });
    const payload = send.mock.calls[0]?.[0] as { subject: string; text: string; html: string };
    expect(payload.subject).toBe("Lịch hẹn đã được dời — Tiệm Mai & Linh");
    expect(payload.html).toContain('<html lang="vi">');
    expect(payload.html).toContain("Lịch hẹn đã được dời");
    expect(payload.html).not.toContain("Appointment Rescheduled");
    expect(payload.html).toContain("<footer data-lang=\"vi\">footer</footer>");
  });
});
