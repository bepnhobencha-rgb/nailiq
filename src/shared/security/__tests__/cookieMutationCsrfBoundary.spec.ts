import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const COOKIE_MUTATION_ROUTES = [
  "src/app/api/customer/[phone]/consents/route.ts",
  "src/app/api/dashboard/copilot/route.ts",
  "src/app/api/dashboard/nail-designs/route.ts",
  "src/app/api/import-website/route.ts",
  "src/app/api/referrals/[id]/revoke/route.ts",
  "src/app/api/staff/photo-upload/route.ts",
  "src/app/api/user/language/route.ts",
];

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(absolute);
    return entry.name === "route.ts" ? [absolute] : [];
  });
}

describe("MQA-0139 cookie mutation CSRF boundary", () => {
  it("keeps a complete inventory of ordinary cookie-authenticated API mutations", () => {
    const apiRoot = path.join(process.cwd(), "src/app/api");
    const discovered = routeFiles(apiRoot)
      .filter((absolute) => {
        const source = readFileSync(absolute, "utf8");
        const mutates = /export async function (?:POST|PUT|PATCH|DELETE)/.test(source);
        const usesAmbientCookieAuth =
          /from\s+["']@\/shared\/lib\/supabase\/server["']/.test(source) ||
          source.includes("getDashboardWriteClient");
        return mutates && usesAmbientCookieAuth;
      })
      .map((absolute) => path.relative(process.cwd(), absolute))
      .sort();

    expect(discovered).toEqual([...COOKIE_MUTATION_ROUTES].sort());
  });

  it.each(COOKIE_MUTATION_ROUTES)("gates %s before auth/body work", (relativePath) => {
    const source = readFileSync(path.join(process.cwd(), relativePath), "utf8");
    const gate = source.indexOf("isSameOriginMutation(");
    expect(gate).toBeGreaterThan(-1);

    const firstMutationHandler = source.search(/export async function (?:POST|PUT|PATCH|DELETE)/);
    expect(firstMutationHandler).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(firstMutationHandler);

    const afterHandler = source.slice(firstMutationHandler);
    const localGate = afterHandler.indexOf("isSameOriginMutation(");
    const authOrBody = afterHandler.search(/(?:\.json\(\)|\.formData\(\)|auth\.getUser\(|getDashboardWriteClient\()/);
    expect(localGate).toBeGreaterThan(-1);
    expect(authOrBody).toBeGreaterThan(-1);
    expect(localGate).toBeLessThan(authOrBody);
  });

  it("keeps the Bearer-without-cookie exception limited to customer consent", () => {
    for (const relativePath of COOKIE_MUTATION_ROUTES) {
      const source = readFileSync(path.join(process.cwd(), relativePath), "utf8");
      const hasException = source.includes("allowBearerWithoutCookie: true");
      expect(hasException).toBe(relativePath.includes("customer/[phone]/consents"));
    }
  });

  it("pins the installed Next Server Action Origin/Host abort invariant", () => {
    const actionHandlerPath = require.resolve("next/dist/server/app-render/action-handler");
    const source = readFileSync(actionHandlerPath, "utf8");
    expect(source).toContain("originHost !== host.value");
    expect(source).toContain("Invalid Server Actions request.");
    expect(source).toContain("isCsrfOriginAllowed");
  });
});
