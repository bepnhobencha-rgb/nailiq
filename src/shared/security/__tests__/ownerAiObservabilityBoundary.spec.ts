import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const activity = read("src/shared/ai/loadMinhActivity.ts");
const exceptions = read("src/shared/ai/operationalExceptions.ts");
const exceptionType = read("src/shared/ai/operationalExceptionTypes.ts");

describe("owner AI observability serialization boundary", () => {
  it("rebuilds bounded activity rows instead of returning raw payloads", () => {
    expect(activity).toContain("boundedDisplayText");
    expect(activity).toContain("clientName: boundedDisplayText");
    expect(activity).toContain("messagePreview: boundedDisplayText");
    expect(activity).not.toMatch(/return\s+\{[\s\S]*\.\.\.row/);
  });

  it("queries only the operational exception fields rendered by the owner UI", () => {
    expect(exceptions).toContain("OWNER_EXCEPTION_COLUMNS");
    expect(exceptions).toContain("toOperationalExceptionDisplayRow");
    expect(exceptions).not.toContain('"id, kind, severity');
    expect(exceptions).not.toContain("source_ref: String");
    expect(exceptionType).not.toContain("source_ref:");
    expect(exceptionType).not.toContain("acknowledged_at:");
    expect(exceptionType).not.toContain("first_seen_at:");
  });
});
