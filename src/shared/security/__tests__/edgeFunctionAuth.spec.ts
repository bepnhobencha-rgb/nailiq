import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const privilegedFunctions = [
  "cron-auto-reconfirm",
  "cron-birthday-voucher",
  "cron-trend-refresh",
  "cron-welcome-back",
  "pattern-detector",
  "photo-enhance",
  "photo-send-sms",
  "referral-claim",
  "referral-complete",
  "reschedule-sms",
  "scrape-website",
] as const;

function sourceFor(slug: string): string {
  return readFileSync(resolve(process.cwd(), "supabase/functions", slug, "index.ts"), "utf8");
}

describe("privileged Supabase Edge Function authentication", () => {
  it.each(privilegedFunctions)("protects %s before parsing its request body", (slug) => {
    const source = sourceFor(slug);
    const authCall = source.indexOf("rejectUnauthorizedInternalRequest(req");
    const bodyParse = source.indexOf("req.json(");

    expect(source).toContain('../_shared/internalAuth.ts');
    expect(authCall).toBeGreaterThan(-1);
    expect(bodyParse).toBeGreaterThan(-1);
    expect(authCall).toBeLessThan(bodyParse);
  });

  it("keeps the website importer disabled unless explicitly enabled", () => {
    const source = sourceFor("scrape-website");
    expect(source).toContain('Deno.env.get("WEBSITE_IMPORT_ENABLED") !== "true"');
    expect(source).toContain("website_import_disabled");
  });

  it("fails closed when the internal credential is absent", () => {
    const source = readFileSync(
      resolve(process.cwd(), "supabase/functions/_shared/internalAuth.ts"),
      "utf8",
    );

    expect(source).toContain("if (!expected) return false");
    expect(source).toContain("if (!presented) return false");
    expect(source).toContain('status: 401');
    expect(source).toContain('crypto.subtle.digest("SHA-256"');
    expect(source).toContain('Deno.env.get("OUTBOUND_MESSAGING_ENABLED") === "true"');
    expect(source).toContain('Deno.env.get("MAX_OUTBOUND_MESSAGES_PER_RUN") ?? "100"');
  });

  it.each([
    "cron-auto-reconfirm",
    "cron-birthday-voucher",
    "cron-welcome-back",
    "photo-send-sms",
    "reschedule-sms",
  ])("gives %s a fail-closed messaging kill switch", (slug) => {
    const source = sourceFor(slug);
    expect(source).toContain("outboundMessagingEnabled()");
    expect(source).toContain("outbound_messaging_disabled");
  });
});
