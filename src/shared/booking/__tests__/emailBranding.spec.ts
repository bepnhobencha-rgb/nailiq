import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildEmailBrandHeader,
  normalizeEmailLogoUrl,
} from "@/shared/booking/emailBranding";

describe("transactional email salon branding", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders a bounded HTTPS salon logo with escaped alt text", () => {
    const logoUrl = "https://project-ref.supabase.co/storage/v1/object/public/salon-imports/salon/logo.png";
    const html = buildEmailBrandHeader({
      salonName: 'Huy & <Friends> "Nails"',
      logoUrl,
      subtitle: "Booking Confirmed",
    });

    expect(html).toContain(`<img src="${logoUrl}"`);
    expect(html).toContain('alt="Huy &amp; &lt;Friends&gt; &quot;Nails&quot; logo"');
    expect(html).not.toContain("Huy & <Friends>");
  });

  it.each([
    "javascript:alert(1)",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "http://cdn.example.test/logo.png",
    "https://user:secret@cdn.example.test/logo.png",
    "https://cdn.example.test/logo.png",
    "not a url",
    "x".repeat(2_049),
  ])("rejects unsafe logo URL %s", (logoUrl) => {
    expect(normalizeEmailLogoUrl(logoUrl)).toBeNull();
    const html = buildEmailBrandHeader({
      salonName: "Salon QA",
      logoUrl,
      subtitle: "Confirmed",
    });
    expect(html).not.toContain("<img");
    expect(html).toContain(">Salon QA</span>");
  });

  it("uses the salon name fallback instead of hard-coded product branding", () => {
    const html = buildEmailBrandHeader({
      salonName: "  Hi-Lite Studio  ",
      logoUrl: null,
      subtitle: "Group Booking Confirmed",
    });
    expect(html).toContain(">Hi-Lite Studio</span>");
    expect(html).not.toContain(">NailIQ</span>");
  });
});
