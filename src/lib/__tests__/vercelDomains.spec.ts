import { afterEach, describe, expect, it, vi } from "vitest";
import { getDomainsClient } from "@/lib/vercelDomains";

describe("vercelDomains", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("bounds Vercel API calls with an abort signal", async () => {
    vi.stubEnv("VERCEL_API_TOKEN", "test-vercel-api-key");
    vi.stubEnv("VERCEL_PROJECT_ID", "test-project");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ verified: true, misconfigured: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = getDomainsClient();
    expect(client).not.toBeNull();
    await client!.status("booking.example.com");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
