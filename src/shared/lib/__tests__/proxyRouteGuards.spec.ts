import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * src/proxy.ts must not go back to prefix matching on route guards.
 *
 * This is a regression that reintroduces itself: `pathname.startsWith("/x")`
 * reads perfectly naturally, it is what everyone types first, and when it is
 * wrong nothing crashes — a salon's booking page just quietly redirects to
 * /login and the salon assumes NailIQ is broken. There is no stack trace and no
 * error-rate spike to notice; the request is a tidy 307.
 *
 * The routeBoundary unit tests prove the helper is correct. This one proves
 * proxy.ts actually uses it.
 */
const PROXY = join(process.cwd(), "src/proxy.ts");
const source = readFileSync(PROXY, "utf8");

/** Source with comments stripped, so prose about the bug is not read as code. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

describe("proxy.ts route guards respect segment boundaries", () => {
  it("uses the boundary helper", () => {
    expect(code).toContain("isRouteOrUnder");
  });

  it.each(["/dashboard", "/superadmin", "/auth", "/api"])(
    "does not prefix-match %s with startsWith",
    (route) => {
      expect(
        code,
        `pathname.startsWith("${route}") also matches "${route}-abc", which is a ` +
          `legal salon slug. Use isRouteOrUnder(pathname, "${route}") instead.`,
      ).not.toContain(`startsWith("${route}")`);
    },
  );

  it("has no startsWith path check left on any route guard", () => {
    // Catches a new guard added tomorrow with the same shape.
    const offenders = code.match(/pathname\.startsWith\("\/[^"]*"\)/g) ?? [];
    expect(
      offenders,
      "every route guard must go through isRouteOrUnder — see the /dashboard-abc bug",
    ).toEqual([]);
  });
});
