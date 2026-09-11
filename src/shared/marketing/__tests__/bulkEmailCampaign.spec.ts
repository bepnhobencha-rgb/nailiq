import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  bulkEmailCampaignInputSchema,
  bulkEmailContentFingerprint,
  renderBulkEmailCampaign,
} from "../bulkEmailCampaign";

const campaign = {
  name: "September spa special",
  subject: "A relaxing offer from Hi-Lite",
  preheader: "Book before September 13",
  headline: "A little time for you",
  body: "Enjoy our signature service.\n\nAppointments are limited.",
  imageUrl: "https://images.example.test/special.jpg",
  ctaLabel: "Book now",
  ctaUrl: "https://nailiq.ca/hilite-anaheim",
  canarySize: 25,
  batchSize: 100,
  sendAfter: "",
};

describe("bulk email campaign content", () => {
  it("accepts HTTPS content and produces a deterministic fingerprint", () => {
    const parsed = bulkEmailCampaignInputSchema.parse(campaign);
    expect(bulkEmailContentFingerprint(parsed)).toMatch(/^[0-9a-f]{64}$/);
    expect(bulkEmailContentFingerprint(parsed)).toBe(bulkEmailContentFingerprint({ ...parsed }));
  });

  it("rejects header injection and non-HTTPS campaign links", () => {
    expect(bulkEmailCampaignInputSchema.safeParse({ ...campaign, subject: "Offer\nBcc: bad@example.com" }).success).toBe(false);
    expect(bulkEmailCampaignInputSchema.safeParse({ ...campaign, ctaUrl: "http://nailiq.ca" }).success).toBe(false);
    expect(bulkEmailCampaignInputSchema.safeParse({ ...campaign, imageUrl: "javascript:alert(1)" }).success).toBe(false);
  });

  it("escapes owner-authored and customer HTML and includes unsubscribe truth", () => {
    const rendered = renderBulkEmailCampaign({
      ...campaign,
      headline: "<script>alert(1)</script>",
      body: "Hello <b>friend</b>",
      clientName: "<Admin>",
      clientEmail: "customer@example.com",
      salonName: "Hi-Lite & Spa",
      salonAddress: "9832 Katella Ave, Anaheim, CA",
    });
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered.html).toContain("Hi &lt;Admin&gt;");
    expect(rendered.html).not.toContain("List-Unsubscribe");
    expect(rendered.html).toContain("Unsubscribe");
    expect(rendered.html).toContain("9832 Katella Ave");
  });
});
