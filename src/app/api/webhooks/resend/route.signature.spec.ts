import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createService: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createService,
}));
// Resend/Svix verification is deliberately NOT mocked. The signing material is
// a public synthetic fixture, never a provider credential or hosted receipt.
import { POST } from "./route";

const key = Buffer.from("synthetic-webhook-test-key-32byte!");
const secret = `whsec_${key.toString("base64")}`;
const now = new Date("2026-09-25T02:00:00.000Z");
const timestamp = String(now.getTime() / 1_000);
const ref = "uhpzafoiifupyypkcwln";
const recipient = "waitlist-qa@example.invalid";

function body(overrides: { ref?: string; to?: string[]; qa?: boolean } = {}) {
  return JSON.stringify({
    type: "email.delivered",
    created_at: now.toISOString(),
    data: {
      created_at: now.toISOString(),
      email_id: "synthetic-resend-signature-receipt",
      from: "QA <qa@example.invalid>",
      to: overrides.to ?? [recipient],
      subject: "Private synthetic subject must not persist",
      tags: {
        nailiq_email: "waitlist_offer",
        nailiq_audience: "customer",
        nailiq_flow: "waitlist_offer",
        ...(overrides.qa === false ? {} : { nailiq_env: "qa", nailiq_qa_ref: overrides.ref ?? ref }),
      },
    },
  });
}

function signed(raw: string, options: { time?: string; id?: string; key?: Buffer } = {}) {
  const time = options.time ?? timestamp;
  const id = options.id ?? "evt_synthetic_waitlist_signature";
  const signature = createHmac("sha256", options.key ?? key)
    .update(`${id}.${time}.${raw}`).digest("base64");
  return new Request("https://qa.example.invalid/api/webhooks/resend", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": time,
      "svix-signature": `v1,${signature}`,
    },
    body: raw,
  });
}

describe("Resend QA route with real SDK signature verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in signature test"); }));
    vi.stubEnv("RESEND_WEBHOOK_SECRET", secret);
    vi.stubEnv("NAILIQ_RESEND_QA_WEBHOOK_ONLY", "1");
    vi.stubEnv("NAILIQ_DISPOSABLE_DB", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF", ref);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `https://${ref}.supabase.co`);
    vi.stubEnv("SUPABASE_INTERNAL_URL", `https://${ref}.supabase.co`);
    vi.stubEnv("NAILIQ_QA_RESEND_EMAIL_RECIPIENT", recipient);
    mocks.createService.mockReturnValue({ rpc: mocks.rpc });
    mocks.rpc.mockResolvedValue({ data: { success: true, code: "event_applied" }, error: null });
  });

  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("verifies a real signature then persists only fingerprinted QA material", async () => {
    const raw = body();
    const result = await POST(signed(raw));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("record_resend_registered_email_delivery_event", {
      p_provider_event_id: "evt_synthetic_waitlist_signature",
      p_provider_message_id: "synthetic-resend-signature-receipt",
      p_email_key: "waitlist_offer",
      p_audience: "customer",
      p_event_type: "email.delivered",
      p_recipient_fingerprint: createHash("sha256").update(recipient).digest("hex"),
      p_recipient_count: 1,
      p_occurred_at: now.toISOString(),
      p_payload_fingerprint: createHash("sha256").update(raw).digest("hex"),
    });
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(recipient);
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain("Private synthetic subject");
  });

  it("rejects modified body bytes even when the original signature was valid", async () => {
    const original = signed(body());
    const changed = new Request(original.url, {
      method: "POST", headers: original.headers, body: body().replace("email.delivered", "email.bounced"),
    });
    expect((await POST(changed)).status).toBe(401);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("rejects a signature from a different secret", async () => {
    expect((await POST(signed(body(), { key: Buffer.from("another-synthetic-key") }))).status).toBe(401);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it.each([-600, 600])("rejects signed timestamps outside tolerance (%s seconds)", async (offset) => {
    expect((await POST(signed(body(), { time: String(Number(timestamp) + offset) }))).status).toBe(401);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it.each(["svix-id", "svix-timestamp", "svix-signature"])("rejects missing %s", async (name) => {
    const request = signed(body());
    request.headers.delete(name);
    expect((await POST(request)).status).toBe(401);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it.each([
    { qa: false },
    { ref: "aaaaaaaaaaaaaaaaaaaa" },
    { to: ["another@example.invalid"] },
    { to: [recipient, "another@example.invalid"] },
  ])("ignores cryptographically valid but out-of-scope events (%j)", async (overrides) => {
    const result = await POST(signed(body(overrides)));
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ ok: true, code: "event_ignored" });
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("rejects a valid signed QA event if the runtime resolves to Production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await POST(signed(body()))).status).toBe(503);
    expect(mocks.createService).not.toHaveBeenCalled();
  });
});
