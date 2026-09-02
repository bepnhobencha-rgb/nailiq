import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO = process.cwd();

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO, relative), "utf8");
}

describe("TurnIQ M4I local browser harness boundary", () => {
  const page = read("src/app/e2e-local/turniq-supervised-staggered/page.tsx");
  const harness = read(
    "src/app/e2e-local/turniq-supervised-staggered/TurnIqSupervisedStaggeredHarness.tsx",
  );
  const proxy = read("src/proxy.ts");

  it("is unavailable without the local test flag or away from loopback", () => {
    expect(page).toContain("!isDemoSlugPinBypassed()");
    expect(page).toContain("LOOPBACK_HOST_RE.test(host)");
    expect(page).toContain("notFound()");
    expect(proxy).toContain('pathnameEarly.startsWith("/e2e-local/")');
    expect(proxy).toContain("LOOPBACK_HOST_RE.test");
  });

  it("uses in-memory fixtures without a database, auth or provider client", () => {
    expect(harness).not.toMatch(
      /supabase|serviceRole|fetch\(|stripe|square|twilio|resend|customerPhone|customerEmail/i,
    );
    expect(harness).toContain("Synthetic TurnIQ M4I");
    expect(harness).toContain('scenario === "stale"');
    expect(harness).toContain('scenario === "offline"');
  });
});
