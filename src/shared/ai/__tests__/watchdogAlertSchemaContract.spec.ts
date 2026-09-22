import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

describe("watchdog alert schema contract", () => {
  it("keeps digest reads and cancellation writes on deployed columns", () => {
    const baseline = read(
      "supabase/migrations/20260723000000_folded_production_schema_baseline.sql",
    );
    const table = baseline.match(
      /CREATE TABLE public\.watchdog_alerts \(([\s\S]*?)\n\);/,
    )?.[1];
    const digest = read("src/shared/ai/agentDigest.ts");
    const cancellationRadar = read("src/shared/ai/agentCancellationRadar.ts");

    expect(table).toBeDefined();
    expect(table).toContain("title text NOT NULL");
    expect(table).toContain("body text");
    expect(table).not.toMatch(/\bsummary\b/);

    expect(digest).toContain('.select("kind, title, severity")');
    expect(digest).not.toContain('.select("kind, summary, severity")');
    expect(cancellationRadar).not.toMatch(/\n\s+summary:\s*body,/);
  });
});
