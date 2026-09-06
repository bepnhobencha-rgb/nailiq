import { Webhook } from "standardwebhooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleAuthEmailHook,
  normalizeAuthEmailHookSecret,
  type AuthEmailHookDependencies,
  type AuthEmailMessage,
} from "../../../../supabase/functions/_shared/authEmailHook";

const RAW_SECRET = Buffer.from("nailiq-auth-email-test-secret").toString("base64");
const CONFIGURED_SECRET = `v1,whsec_${RAW_SECRET}`;
const SIGNING_DATE = new Date();

function recoveryPayload(overrides: Record<string, unknown> = {}) {
  return {
    user: { email: "owner@example.com" },
    email_data: {
      token: "123456",
      token_hash: "signed-token-hash",
      redirect_to: "https://nailiq.ca/auth/recovery?surface=salon",
      site_url: "https://nailiq.ca",
      email_action_type: "recovery",
    },
    ...overrides,
  };
}

function signedRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const webhook = new Webhook(RAW_SECRET);
  return new Request("https://example.supabase.co/functions/v1/nailiq-auth-email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": "msg_test_nailiq",
      "webhook-signature": webhook.sign(
        "msg_test_nailiq",
        SIGNING_DATE,
        body,
      ),
      "webhook-timestamp": String(Math.floor(SIGNING_DATE.getTime() / 1000)),
    },
    body,
  });
}

describe("NailIQ Auth Send Email Hook", () => {
  let sent: AuthEmailMessage[];
  let logs: Array<{ event: string; context?: Readonly<Record<string, string | number>> }>;
  let dependencies: AuthEmailHookDependencies;

  beforeEach(() => {
    sent = [];
    logs = [];
    dependencies = {
      from: "NailIQ <noreply@nailiq.ca>",
      resendConfigured: true,
      signingSecret: CONFIGURED_SECRET,
      supabaseUrl: "https://example.supabase.co",
      verifySignedPayload: (body, headers, secret) =>
        new Webhook(secret).verify(body, headers),
      sendEmail: vi.fn(async (message) => {
        sent.push(message);
        return { id: `email-${sent.length}` };
      }),
      log: (event, context) => logs.push({ event, context }),
    };
  });

  it("normalizes the dashboard hook-secret format", () => {
    expect(normalizeAuthEmailHookSecret(CONFIGURED_SECRET)).toBe(RAW_SECRET);
    expect(normalizeAuthEmailHookSecret(`whsec_${RAW_SECRET}`)).toBe(RAW_SECRET);
  });

  it("verifies and delivers one recovery email with the correct link", async () => {
    const response = await handleAuthEmailHook(
      signedRequest(recoveryPayload()),
      dependencies,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["owner@example.com"]);
    expect(sent[0].subject).toBe("Reset your NailIQ password");
    expect(sent[0].text).toContain(
      "https://example.supabase.co/auth/v1/verify?token=signed-token-hash&type=recovery",
    );
    expect(sent[0].text).toContain("redirect_to=https%3A%2F%2Fnailiq.ca");
    expect(sent[0].idempotencyKey).toMatch(/^nailiq-auth-[a-f0-9]{64}$/);
    expect(logs).toEqual([
      {
        event: "auth_email_hook_completed",
        context: { action: "recovery", deliveries: 1 },
      },
    ]);
  });

  it("rejects an invalid signature before provider delivery", async () => {
    const request = signedRequest(recoveryPayload());
    request.headers.set("webhook-signature", "v1,invalid");

    const response = await handleAuthEmailHook(request, dependencies);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { http_code: 401, message: "invalid_webhook_signature" },
    });
    expect(sent).toHaveLength(0);
    expect(logs[0]?.event).toBe("auth_email_hook_signature_rejected");
  });

  it("fails closed when configuration is missing", async () => {
    dependencies.resendConfigured = false;

    const response = await handleAuthEmailHook(
      signedRequest(recoveryPayload()),
      dependencies,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { http_code: 500, message: "hook_not_configured" },
    });
    expect(sent).toHaveLength(0);
  });

  it("propagates provider failure in the Auth Hook error contract", async () => {
    dependencies.sendEmail = vi.fn(async () => ({ error: "provider_failed" }));

    const response = await handleAuthEmailHook(
      signedRequest(recoveryPayload()),
      dependencies,
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { http_code: 502, message: "email_delivery_failed" },
    });
    expect(logs[0]).toEqual({
      event: "auth_email_hook_delivery_failed",
      context: { action: "recovery", delivery: 1 },
    });
  });

  it("rejects malformed signed payloads without exposing or sending PII", async () => {
    const response = await handleAuthEmailHook(
      signedRequest(recoveryPayload({ user: { email: "not-an-email" } })),
      dependencies,
    );

    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(JSON.stringify(logs)).not.toContain("not-an-email");
  });

  it("uses the same provider idempotency key for a signed retry", async () => {
    await handleAuthEmailHook(signedRequest(recoveryPayload()), dependencies);
    await handleAuthEmailHook(signedRequest(recoveryPayload()), dependencies);

    expect(sent).toHaveLength(2);
    expect(sent[0].idempotencyKey).toBe(sent[1].idempotencyKey);
  });

  it("maps both secure email-change messages to the documented token hashes", async () => {
    const payload = {
      user: {
        email: "current@example.com",
        new_email: "new@example.com",
      },
      email_data: {
        token: "current-code",
        token_hash: "new-email-hash",
        token_new: "new-code",
        token_hash_new: "current-email-hash",
        redirect_to: "https://nailiq.ca/auth/recovery",
        email_action_type: "email_change",
      },
    };

    const response = await handleAuthEmailHook(
      signedRequest(payload),
      dependencies,
    );

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[0].to).toEqual(["current@example.com"]);
    expect(sent[0].text).toContain("token=current-email-hash");
    expect(sent[0].text).toContain("current-code");
    expect(sent[1].to).toEqual(["new@example.com"]);
    expect(sent[1].text).toContain("token=new-email-hash");
    expect(sent[1].text).toContain("new-code");
  });
});
