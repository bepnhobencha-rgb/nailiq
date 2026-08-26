import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createService: vi.fn(),
  getToken: vi.fn(),
  validate: vi.fn(),
  record: vi.fn(),
  from: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createService,
}));
vi.mock("@/shared/lib/twilioSignature", () => ({
  getTwilioAuthToken: mocks.getToken,
  validateTwilioSignature: mocks.validate,
  twilioRequestBaseUrl: () => "https://nailiq.test",
}));
vi.mock("@/shared/reminders/smsConsentSuppression", () => ({
  recordInboundSmsConsent: mocks.record,
}));

import { POST as reminderInboundPost } from "./route";
import { POST as aiInboundPost } from "../sms/route";

const accountSid = `AC${"1".repeat(32)}`;
const messageSid = `SM${"2".repeat(32)}`;

function request(path: string, body: string, headers: Record<string, string> = {}) {
  return new NextRequest(`https://nailiq.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": "signed",
      ...headers,
    },
    body,
  });
}

function stopBody(extra: Record<string, string> = {}) {
  return new URLSearchParams({
    AccountSid: accountSid,
    MessageSid: messageSid,
    From: "+16045550123",
    To: "+17789073426",
    Body: "CANCEL",
    OptOutType: "STOP",
    ...extra,
  }).toString();
}

describe("Twilio inbound SMS consent boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createService.mockReturnValue({ from: mocks.from });
    mocks.getToken.mockResolvedValue("auth-token");
    mocks.validate.mockReturnValue(true);
    mocks.record.mockResolvedValue({
      ok: true,
      code: "applied",
      effectiveState: "suppressed",
      replay: false,
    });
  });

  it.each([
    ["reminder", "/api/twilio/inbound", reminderInboundPost],
    ["AI receptionist", "/api/twilio/sms?slug=qa-salon", aiInboundPost],
  ] as const)("records signed provider STOP before any booking/AI work on %s webhook", async (_label, path, post) => {
    const response = await post(request(path, stopBody()));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledWith({
      accountSid,
      messageSid,
      fromPhone: "+16045550123",
      toPhone: "+17789073426",
      optOutType: "STOP",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    ["missing Content-Length", {}],
    ["spoofed small Content-Length", { "content-length": "10" }],
  ])("rejects an oversized actual reminder body with %s before service-role access", async (_label, headers) => {
    const response = await reminderInboundPost(request(
      "/api/twilio/inbound",
      `Body=${"x".repeat(17_000)}`,
      headers,
    ));
    expect(response.status).toBe(400);
    expect(mocks.createService).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("rejects an oversized AI webhook body before service-role or model work", async () => {
    const response = await aiInboundPost(request(
      "/api/twilio/sms?slug=qa-salon",
      `Body=${"x".repeat(17_000)}`,
      { "content-length": "12" },
    ));
    expect(response.status).toBe(400);
    expect(mocks.createService).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("fails closed when the durable STOP receipt cannot be recorded", async () => {
    mocks.record.mockResolvedValueOnce({ ok: false, code: "consent_unavailable" });
    const response = await reminderInboundPost(request("/api/twilio/inbound", stopBody()));
    expect(response.status).toBe(503);
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature before consent or booking mutation", async () => {
    mocks.validate.mockReturnValueOnce(false);
    const response = await reminderInboundPost(request("/api/twilio/inbound", stopBody()));
    expect(response.status).toBe(403);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
