import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const SALON_ID = "65000000-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  integrationError: null as Record<string, unknown> | null,
  syncSquareEmailConsent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/cronAuthorization", () => ({
  requireCronAuthorization: () => null,
}));
vi.mock("@/shared/security/cronRunHistory", () => ({
  runTrackedCron: (_worker: string, handler: () => Promise<Response>) => handler(),
}));
vi.mock("@/shared/integrations/square/emailConsentSync", () => ({
  syncSquareEmailConsent: mocks.syncSquareEmailConsent,
}));
vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        not: () => query,
        then: <TResult1 = unknown, TResult2 = never>(
          onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) => Promise.resolve({
          data: mocks.integrationError ? null : [{ salon_id: SALON_ID }],
          error: mocks.integrationError,
        }).then(onfulfilled, onrejected),
      };
      return query;
    },
  }),
}));

import { GET } from "./route";

function request() {
  return new NextRequest("https://nailiq.test/api/cron/square-email-consent");
}

describe("GET /api/cron/square-email-consent health truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SQUARE_EMAIL_CONSENT_SYNC", "1");
    mocks.integrationError = null;
    mocks.syncSquareEmailConsent.mockResolvedValue({
      ok: true,
      squareCustomers: 1,
      granted: 1,
      revoked: 0,
    });
  });

  it("returns HTTP 500 and hides detail when a salon reports ok=false", async () => {
    mocks.syncSquareEmailConsent.mockResolvedValue({
      ok: false,
      squareCustomers: 7,
      granted: 2,
      revoked: 1,
      error: "private provider or database detail",
    });

    const response = await GET(request());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      results: {
        [SALON_ID]: {
          ok: false,
          squareCustomers: 7,
          granted: 2,
          revoked: 1,
          error: "square_email_consent_sync_failed",
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("private provider or database detail");
  });

  it("returns HTTP 500 with a stable result when a salon throws", async () => {
    mocks.syncSquareEmailConsent.mockRejectedValue(
      new Error("private thrown detail for a customer"),
    );

    const response = await GET(request());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      results: {
        [SALON_ID]: {
          ok: false,
          error: "square_email_consent_sync_failed",
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("private thrown detail");
  });

  it("sanitizes integration inventory failures", async () => {
    mocks.integrationError = { code: "42501", message: "private database detail" };

    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "square_email_consent_integrations_unavailable",
    });
    expect(mocks.syncSquareEmailConsent).not.toHaveBeenCalled();
  });
});
