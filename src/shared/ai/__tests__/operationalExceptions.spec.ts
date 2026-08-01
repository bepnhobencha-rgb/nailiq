import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { toOperationalExceptionDisplayRow } from "@/shared/ai/operationalExceptions";

describe("owner operational exception boundary", () => {
  it("returns only bounded display fields", () => {
    const row = toOperationalExceptionDisplayRow({
      id: "exception-1",
      severity: "critical",
      title: `Worker failed ${"t".repeat(300)}`,
      body: `Safe explanation ${"b".repeat(1_000)}`,
      status: "open",
      created_at: "2026-07-30T04:30:00.000Z",
      resolution_note: `Recovered ${"r".repeat(700)}`,
      source_type: "ai_execution",
      occurrence_count: 3,
      last_seen_at: "2026-07-30T04:35:00.000Z",
    });

    expect(row).toMatchObject({
      id: "exception-1",
      severity: "critical",
      status: "open",
      source_type: "ai_execution",
      occurrence_count: 3,
    });
    expect(row?.title).toHaveLength(160);
    expect(row?.body).toHaveLength(600);
    expect(row?.resolution_note).toHaveLength(500);
    expect(Object.keys(row ?? {})).not.toContain("source_ref");
    expect(Object.keys(row ?? {})).not.toContain("kind");
    expect(Object.keys(row ?? {})).not.toContain("acknowledged_at");
  });

  it("rejects invalid state and normalizes arbitrary source labels", () => {
    const base = {
      id: "exception-2",
      severity: "warning",
      title: "Worker delayed",
      body: null,
      status: "open",
      created_at: "2026-07-30T04:30:00.000Z",
      resolution_note: null,
      source_type: "<script>source</script>",
      occurrence_count: -4,
      last_seen_at: "2026-07-30T04:35:00.000Z",
    };

    expect(toOperationalExceptionDisplayRow(base)).toMatchObject({
      source_type: "unknown",
      occurrence_count: 1,
    });
    expect(
      toOperationalExceptionDisplayRow({ ...base, status: "unexpected" }),
    ).toBeNull();
  });
});
