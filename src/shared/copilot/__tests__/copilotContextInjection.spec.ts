import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runCopilotTool } from "@/shared/copilot/copilotContext";

type QueryResult = { data: unknown[]; error: null };

function emptyQuery(ilikeCalls: Array<[string, string]>) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    ilike: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    then: (
      resolve: (value: QueryResult) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.ilike.mockImplementation((column: string, value: string) => {
    ilikeCalls.push([column, value]);
    return query;
  });
  query.order.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
}

describe("Coco appointment lookup query boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps adversarial customer text out of raw PostgREST or grammar", async () => {
    const ilikeCalls: Array<[string, string]> = [];
    const from = vi.fn(() => emptyQuery(ilikeCalls));
    const injected = "Anna),id.neq.00000000-0000-4000-8000-000000000000";

    const result = await runCopilotTool({
      db: { from } as never,
      salonId: "11111111-1111-4111-8111-111111111111",
      timezone: "America/Vancouver",
      name: "find_appointment",
      input: { query: injected },
    });

    expect(JSON.parse(result.content)).toEqual({
      found: false,
      message: `No appointments found for "${injected}".`,
    });
    expect(from).toHaveBeenCalledTimes(2);
    expect(ilikeCalls).toEqual([
      ["client_name", `%${injected}%`],
      ["client_phone", `%${injected}%`],
    ]);
  });

  it("escapes LIKE wildcards instead of allowing a broad salon lookup", async () => {
    const ilikeCalls: Array<[string, string]> = [];
    const from = vi.fn(() => emptyQuery(ilikeCalls));

    await runCopilotTool({
      db: { from } as never,
      salonId: "11111111-1111-4111-8111-111111111111",
      timezone: "America/Vancouver",
      name: "find_appointment",
      input: { query: "A%_\\B" },
    });

    expect(ilikeCalls).toEqual([
      ["client_name", String.raw`%A\%\_\\B%`],
      ["client_phone", String.raw`%A\%\_\\B%`],
    ]);
  });
});
