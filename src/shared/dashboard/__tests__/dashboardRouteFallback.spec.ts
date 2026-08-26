import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("authenticated dashboard route fallbacks", () => {
  it("places the loading boundary above the data-reading salon layout", () => {
    const parentLoading = read("src/app/dashboard/loading.tsx");
    const salonLoading = read("src/app/dashboard/[slug]/loading.tsx");

    expect(parentLoading).toContain('from "./[slug]/loading"');
    expect(salonLoading).toContain('aria-label="Loading dashboard"');
    expect(salonLoading).toContain("Loading dashboard…");
    expect(salonLoading).toContain("animate-spin");
  });

  it("shows a recoverable dashboard error instead of a blank screen", () => {
    const errorBoundary = read("src/app/dashboard/error.tsx");

    expect(errorBoundary).toContain('"use client"');
    expect(errorBoundary).toContain("ErrorReporter.captureException(error)");
    expect(errorBoundary).toContain("onClick={reset}");
    expect(errorBoundary).toContain("Dashboard could not load");
  });
});
