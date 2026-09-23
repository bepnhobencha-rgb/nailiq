import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@/shared/lib/resend", () => ({
  getResendClient: () => ({ emails: { send } }),
  getResendFrom: () => "NailIQ <hello@nailiq.ca>",
}));

import { GET, POST } from "./route";

const TOKEN = "a".repeat(64);
const URL = "https://uhpzafoiifupyypkcwln.supabase.co";

function request(auth = true): Request {
  return new Request("https://preview.example.test/api/qa/one-email-20260922", {
    method: "POST",
    headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
  });
}

beforeEach(() => {
  const env: Record<string, string> = {
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: "audit/p0-03-tenant-runtime-20260921",
    NAILIQ_DISPOSABLE_DB: "1",
    NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF: "uhpzafoiifupyypkcwln",
    NEXT_PUBLIC_SUPABASE_URL: URL,
    SUPABASE_INTERNAL_URL: URL,
    NAILIQ_RESEND_QA_WEBHOOK_ONLY: "1",
    NAILIQ_QA_RESEND_EMAIL_RECIPIENT: "t.huy2606@icloud.com",
    NAILIQ_QA_ONE_EMAIL_TOKEN: TOKEN,
    DISABLE_OUTBOUND_SMS: "1",
    DISABLE_OUTBOUND_CALLS: "1",
    DISABLE_OUTBOUND_EMAIL: "1",
    PAYMENT_LEDGER_WORKERS_ENABLED: "false",
    NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH: "false",
    NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH: "false",
    NAILIQ_CARD_SAVE_DISPATCH_DISABLED: "true",
    NAILIQ_SQUARE_PAYMENT_WEBHOOK_INGESTION: "false",
    RESEND_API_KEY: "qa-test-key",
    SUPABASE_SERVICE_ROLE_KEY: "qa-test-service-key",
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [],
  }));
  send.mockResolvedValue({ data: { id: "provider-test-id" }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("QA one-email route", () => {
  it("hides the route without its private token", async () => {
    expect((await POST(request(false))).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("probes the pinned QA database without sending", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, checks: expect.objectContaining({
      publicQaUrl: true,
      serverQaUrl: true,
      qaKeyValid: true,
    }) });
    expect(fetch).toHaveBeenCalledWith(
      `${URL}/rest/v1/salons?select=id&limit=1`,
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses any Production URL or disabled kill switch", async () => {
    vi.stubEnv("SUPABASE_INTERNAL_URL", "https://fshmobzyjhmtvndobwsy.supabase.co");
    expect((await POST(request())).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    vi.stubEnv("SUPABASE_INTERNAL_URL", URL);
    vi.stubEnv("DISABLE_OUTBOUND_SMS", "0");
    expect((await POST(request())).status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a service-role key that cannot read the QA project", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect((await POST(request())).status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the fixed QA payload once with stable idempotency and QA tags", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, providerMessageId: "provider-test-id" });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: "t.huy2606@icloud.com",
        tags: expect.arrayContaining([
          { name: "nailiq_env", value: "qa" },
          { name: "nailiq_qa_ref", value: "uhpzafoiifupyypkcwln" },
        ]),
      }),
      { idempotencyKey: "nailiq-p1-01-qa-20260922-uhpzafoiifupyypkcwln-v1" },
    );
  });
});
