import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  createAnthropic: vi.fn(),
}));

mocks.eq.mockImplementation(() => ({ maybeSingle: mocks.maybeSingle }));
mocks.select.mockImplementation(() => ({ eq: mocks.eq }));
mocks.from.mockImplementation(() => ({ select: mocks.select }));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: () => ({ from: mocks.from }),
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/shared/ai/anthropicProviderPolicy", () => ({
  createTextBackgroundAnthropicClient: mocks.createAnthropic,
}));

import { runReviewResponder } from "@/shared/ai/agentReviewResponder";

describe("Google Review Responder permission and draft fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    mocks.maybeSingle.mockResolvedValue({
      data: {
        name: "Test Salon",
        google_place_id: "place-123",
        feature_flags: { ai_google_reply: false },
      },
      error: null,
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not read reviews, invoke AI, claim, or draft when disabled", async () => {
    await expect(runReviewResponder("salon-1")).resolves.toBeUndefined();
    expect(mocks.select).toHaveBeenCalledWith(
      "name, feature_flags, google_place_id",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
  });

  it("fails closed when the feature flag cannot be proven", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { name: "Test Salon", google_place_id: "place-123" },
      error: null,
    });
    await expect(runReviewResponder("salon-1")).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("claims before drafting, redacts contact data, and skips an existing review", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: {
        name: "Test Salon",
        google_place_id: "place-123",
        feature_flags: { ai_google_reply: true },
      },
      error: null,
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "OK",
        result: {
          reviews: [
            {
              author_name: "QA Guest",
              rating: 2,
              text: "Không hài lòng. Call +1 604 555 0101 or qa@example.com",
              time: 1_778_000_001,
              language: "vi",
            },
            {
              author_name: "Existing Guest",
              rating: 5,
              text: "Excellent",
              time: 1_778_000_002,
              language: "en",
            },
          ],
        },
      }),
    } as Response);
    mocks.rpc
      .mockResolvedValueOnce({
        data: [
          {
            outcome: "claimed",
            claim_id: "11111111-1111-4111-8111-111111111111",
            claim_token: "22222222-2222-4222-8222-222222222222",
            attempt_count: 1,
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            outcome: "created",
            approval_request_id: "33333333-3333-4333-8333-333333333333",
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            outcome: "existing",
            claim_id: "44444444-4444-4444-8444-444444444444",
            claim_token: null,
            attempt_count: 1,
          },
        ],
        error: null,
      });

    await expect(runReviewResponder("salon-1")).resolves.toBeUndefined();

    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_review_reply_draft",
      "complete_review_reply_draft",
      "claim_review_reply_draft",
    ]);
    const complete = mocks.rpc.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(complete.p_language).toBe("vi");
    expect(complete.p_rating).toBe(2);
    expect(complete.p_review_excerpt).toContain("[phone redacted]");
    expect(complete.p_review_excerpt).toContain("[email redacted]");
    expect(String(complete.p_draft_reply)).toContain("Cảm ơn");
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
  });
});
