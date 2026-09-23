import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/lib/resend", () => ({
  getResendFrom: () => "NailIQ <hello@nailiq.ca>",
}));

import { GET } from "./route";

const TOKEN = "a".repeat(64);
const URL = "https://uhpzafoiifupyypkcwln.supabase.co";

function request(auth = true): Request {
  return new Request("https://preview.example.test/api/qa/one-email-20260922", {
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
    RESEND_API_KEY: "",
    SUPABASE_SERVICE_ROLE_KEY: "qa-test-service-key",
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [],
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("QA one-email read-only preflight", () => {
  it("hides the route without its private token", async () => {
    expect((await GET(request(false))).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the pinned QA database independently of the missing provider key", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      checks: expect.objectContaining({ providerKeyPresent: false, qaKeyValid: true }),
    });
    expect(fetch).toHaveBeenCalledWith(
      `${URL}/rest/v1/salons?select=id&limit=1`,
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("refuses a Production URL before probing", async () => {
    vi.stubEnv("SUPABASE_INTERNAL_URL", "https://fshmobzyjhmtvndobwsy.supabase.co");
    const response = await GET(request());
    expect((await response.json()).checks.qaKeyValid).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a failed QA key probe without guessing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const response = await GET(request());
    expect((await response.json()).checks.qaKeyValid).toBe(false);
  });
});
