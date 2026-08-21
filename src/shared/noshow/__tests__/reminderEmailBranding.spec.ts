import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildGroupReminderEmailHtml,
  buildReminderEmailHtml,
  type GroupReminderEmailInput,
  type ReminderEmailInput,
} from "@/shared/noshow/sendReminderEmail";

const INDIVIDUAL: ReminderEmailInput = {
  salonId: "11111111-1111-4111-8111-111111111111",
  confirmToken: "confirm&value",
  rescheduleToken: "reschedule&value",
  cancelToken: "cancel&value",
  clientName: "Mai",
  clientEmail: "mai@example.test",
  serviceName: "Spa <script>",
  staffName: "Anna & Bee",
  startTimeUtc: "2099-08-20T18:00:00.000Z",
  salonName: "Salon QA",
  salonSlug: "salon-qa",
  salonLogoUrl: "https://project-ref.supabase.co/storage/v1/object/public/salon-imports/salon/logo.png",
};

describe("reminder email branding", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the salon logo and escapes individual reminder content", () => {
    const html = buildReminderEmailHtml(INDIVIDUAL, "Hi <img onerror=alert(1)>");
    expect(html).toContain('src="https://project-ref.supabase.co/storage/v1/object/public/salon-imports/salon/logo.png"');
    expect(html).toContain('alt="Salon QA logo"');
    expect(html).toContain("Spa &lt;script&gt;");
    expect(html).toContain("Anna &amp; Bee");
    expect(html).toContain("Hi &lt;img onerror=alert(1)&gt;");
    expect(html).toContain("token=confirm%26value");
    expect(html).toContain("token=reschedule%26value");
    expect(html).toContain("token=cancel%26value");
  });

  it("renders the same salon brand on a group reminder", () => {
    const group: GroupReminderEmailInput = {
      confirmToken: "group-confirm",
      rescheduleToken: "group-reschedule",
      cancelToken: "group-cancel",
      organizerName: "Mai <Admin>",
      organizerEmail: "mai@example.test",
      salonName: "Salon QA",
      salonSlug: "salon-qa",
      reminderType: "24h",
      salonLogoUrl: "https://project-ref.supabase.co/storage/v1/object/public/salon-imports/salon/group-logo.png",
      members: [{
        name: "Guest <One>",
        serviceName: "Spa & Care",
        staffName: "Anna",
        startTimeUtc: "2099-08-20T18:00:00.000Z",
        status: "confirmed",
      }],
    };
    const html = buildGroupReminderEmailHtml(group);
    expect(html).toContain('src="https://project-ref.supabase.co/storage/v1/object/public/salon-imports/salon/group-logo.png"');
    expect(html).toContain("Mai &lt;Admin&gt;");
    expect(html).toContain("Guest &lt;One&gt;");
    expect(html).toContain("Spa &amp; Care");
    expect(html).toContain("Confirm My Spot");
    expect(html).toContain("Reschedule My Spot");
    expect(html).toContain("Cancel My Spot");
    expect(html).not.toContain("Entire Party");
  });
});
