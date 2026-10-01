import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("waitlist claim GET/POST exposure", () => {
  it("keeps the page read-only and delegates mutation to an explicit client POST", () => {
    const page = read("src/app/booking/waitlist-claim/page.tsx");
    const button = read("src/app/booking/waitlist-claim/WaitlistClaimButton.tsx");
    const recovery = read("src/shared/booking/waitlistClaimRecovery.ts");

    expect(page).toContain("loadWaitlistClaimPreview");
    expect(page).not.toContain("claim_waitlist_slot");
    expect(page).not.toContain("client_name");
    expect(button).toContain('method: "POST"');
    expect(button).toContain('credentials: "same-origin"');
    expect(button).toContain("waitlistClaimRequestId(token, isAvailable)");
    expect(recovery).toContain("stableBookingManagementRequestId");
    expect(recovery).toContain("existingBookingManagementRequestId");
    expect(recovery).toContain("isAvailable ? stableBookingManagementRequestId(intent) : null");
    expect(button).toContain("requestId");
    expect(page).toContain("consumeBookingManagementRateLimit");
  });

  it("offers explicit old-request recovery without mutation during hydration", () => {
    const page = read("src/app/booking/waitlist-claim/page.tsx");
    const button = read("src/app/booking/waitlist-claim/WaitlistClaimButton.tsx");
    expect(page).toContain('isAvailable={preview.state === "available"}');
    expect(page).toContain("key={token}");
    const effect = button.slice(button.indexOf("useEffect(() =>"), button.indexOf("async function submit"));
    expect(effect).toContain("existingBookingManagementRequestId");
    expect(effect).not.toMatch(/fetch\(|submit\(|stableBookingManagementRequestId/);
    expect(button).toContain("Check previous claim");
    expect(button).toContain("if (inFlight.current) return");
  });

  it("applies no-store, no-referrer, and noindex to the capability page", () => {
    const config = read("next.config.ts");
    const page = read("src/app/booking/waitlist-claim/page.tsx");

    expect(config).toContain('source: "/booking/:path*"');
    expect(config).toContain('{ key: "Cache-Control", value: "private, no-store, max-age=0" }');
    expect(config).toContain('{ key: "Referrer-Policy", value: "no-referrer" }');
    expect(config).toContain('{ key: "X-Robots-Tag", value: "noindex, nofollow" }');
    expect(page).toContain("robots: { index: false, follow: false }");
  });
});
