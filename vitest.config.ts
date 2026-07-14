import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests: `src/**/*.spec.ts`.
//
// Deliberately NOT `*.test.ts` — the existing `__tests__/*.test.ts` files are
// hand-rolled scripts run with `npx tsx <file>`, not vitest suites, so vitest
// reports "No test suite found" on them. Playwright owns `e2e/` (testDir), so
// `.spec.ts` under `src/` is unambiguous.
//
// The `@` alias mirrors tsconfig paths so a test can import a module that
// itself imports via `@/…`.
export default defineConfig({
  test: {
    // `e2e/**/*.unit.spec.ts` = pure unit tests for E2E infrastructure (the
    // production guard). Playwright ignores that suffix (see testIgnore in
    // playwright.config.ts), so the two runners never collide.
    include: ["src/**/*.spec.ts", "e2e/**/*.unit.spec.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
