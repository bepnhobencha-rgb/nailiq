import { describe, expect, it, vi } from "vitest";
import {
  type EdgeUsageLedgerClient,
  trackAnthropicEdgeFetch,
} from "../../../../supabase/functions/_shared/aiUsageLedger";

function ledgerClient(
  insert: (row: Record<string, unknown>) => Promise<{ error: null }>,
): EdgeUsageLedgerClient {
  return {
    from: () => ({ insert }),
  };
}

describe("Supabase Edge AI usage ledger", () => {
  it("records tenant usage without consuming the feature response", async () => {
    const rows: Record<string, unknown>[] = [];
    const db = ledgerClient(async (row) => {
      rows.push(row);
      return { error: null };
    });
    const payload = {
      content: [{ type: "text", text: "feature output" }],
      usage: {
        input_tokens: 500,
        output_tokens: 25,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
      },
    };

    const response = await trackAnthropicEdgeFetch(
      db,
      {
        salonId: "00000000-0000-4000-8000-000000000003",
        feature: "photo_enhance",
        model: "claude-haiku-4-5-20251001",
      },
      async () => Response.json(payload),
    );

    await expect(response.json()).resolves.toEqual(payload);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        salon_id: "00000000-0000-4000-8000-000000000003",
        feature: "photo_enhance",
        status: "succeeded",
        input_tokens: 500,
        output_tokens: 25,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
        estimated_cost_usd: 0.000697,
        error_code: null,
      }),
    );
  });

  it("records provider HTTP failures and preserves the response", async () => {
    const rows: Record<string, unknown>[] = [];
    const db = ledgerClient(async (row) => {
      rows.push(row);
      return { error: null };
    });

    const response = await trackAnthropicEdgeFetch(
      db,
      {
        salonId: null,
        feature: "website_import",
        model: "claude-sonnet-4-6",
      },
      async () => new Response("rate limited", { status: 429 }),
    );

    expect(response.status).toBe(429);
    await expect(response.text()).resolves.toBe("rate limited");
    expect(rows[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        error_code: "http_429",
      }),
    );
  });

  it("never breaks the feature response when telemetry is unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = ledgerClient(async () => {
      throw new Error("ledger unavailable");
    });

    const response = await trackAnthropicEdgeFetch(
      db,
      {
        salonId: "00000000-0000-4000-8000-000000000004",
        feature: "website_import",
        model: "claude-sonnet-4-6",
      },
      async () => Response.json({ usage: { input_tokens: 10, output_tokens: 2 } }),
    );

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    expect(warning).toHaveBeenCalledWith(
      "[ai-usage-edge] telemetry unavailable",
      "Error",
    );
    warning.mockRestore();
  });
});
