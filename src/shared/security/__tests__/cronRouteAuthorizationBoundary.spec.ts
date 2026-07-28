import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cronRoot = resolve(process.cwd(), "src/app/api/cron");

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return routeFiles(path);
      }

      return entry.name === "route.ts" ? [path] : [];
    },
  );
}

describe("cron route authorization boundary", () => {
  const routes = routeFiles(cronRoot);

  it("covers every scheduled HTTP route with the centralized boundary", () => {
    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      const source = readFileSync(route, "utf8");
      const uses = source.match(/requireCronAuthorization\(\w+\)/g);

      expect(
        uses,
        `${relative(process.cwd(), route)} must authorize exactly once`,
      ).toHaveLength(1);
      expect(source).toContain(
        'from "@/shared/security/cronAuthorization"',
      );
    }
  });

  it("does not retain route-local CRON_SECRET comparisons", () => {
    for (const route of routes) {
      const source = readFileSync(route, "utf8");

      expect(
        source,
        `${relative(process.cwd(), route)} must use only the shared boundary`,
      ).not.toContain("process.env.CRON_SECRET");
    }
  });
});
