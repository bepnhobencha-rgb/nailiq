import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createService: vi.fn(),
  getToken: vi.fn(),
  validate: vi.fn(),
  updateBySid: vi.fn(),
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
vi.mock("@/shared/lib/notificationLog", () => ({
  updateNotificationBySid: mocks.updateBySid,
}));

import { POST } from "./route";

const messageSid = `SM${"a".repeat(32)}`;

function request(
  body = new URLSearchParams({
    MessageSid: messageSid,
    MessageStatus: "delivered",
  }).toString(),
  headers: Record<string, string> = {},
  url = "https://nailiq.test/api/twilio/status",
) {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": "signed",
      ...headers,
    },
    body,
  });
}

describe("Twilio outbound status callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createService.mockReturnValue({ provider: "local-test" });
    mocks.getToken.mockResolvedValue("auth-token");
    mocks.validate.mockReturnValue(true);
    mocks.updateBySid.mockResolvedValue({ ok: true, code: "applied" });
  });

  it.each([
    ["missing Content-Length", {}],
    ["spoofed small Content-Length", { "content-length": "10" }],
  ])("rejects an oversized actual body with %s before service-role access", async (_label, headers) => {
    const response = await POST(request(`MessageSid=${messageSid}&MessageStatus=delivered&Extra=${"x".repeat(8_192)}`, headers));

    expect(response.status).toBe(400);
    expect(mocks.createService).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.updateBySid).not.toHaveBeenCalled();
  });

  it("fails closed when the Twilio auth token is unavailable", async () => {
    mocks.getToken.mockResolvedValueOnce(null);

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.updateBySid).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature before receipt persistence", async () => {
    mocks.validate.mockReturnValueOnce(false);

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mocks.updateBySid).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed SID", { MessageSid: "SM-short", MessageStatus: "delivered" }],
    ["unknown status", { MessageSid: messageSid, MessageStatus: "invented" }],
    ["missing status", { MessageSid: messageSid }],
  ])("rejects a signed %s receipt", async (_label, fields) => {
    const response = await POST(request(new URLSearchParams(fields).toString()));

    expect(response.status).toBe(422);
    expect(mocks.updateBySid).not.toHaveBeenCalled();
  });

  it.each(["accepted", "queued", "sending", "sent", "read", "canceled"])(
    "acknowledges the recognized %s lifecycle state without a terminal write",
    async (MessageStatus) => {
      const response = await POST(request(new URLSearchParams({
        MessageSid: messageSid,
        MessageStatus,
      }).toString()));

      expect(response.status).toBe(200);
      expect(mocks.updateBySid).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["malformed error code", "provider-error"],
    ["delivered receipt carrying an error", "30003"],
  ])("rejects a signed %s", async (_label, ErrorCode) => {
    const response = await POST(request(new URLSearchParams({
      MessageSid: messageSid,
      MessageStatus: "delivered",
      ErrorCode,
    }).toString()));

    expect(response.status).toBe(422);
    expect(mocks.updateBySid).not.toHaveBeenCalled();
  });

  it.each([
    ["database error", { ok: false, code: "database_error" }],
    ["zero-row update", { ok: false, code: "not_found" }],
  ])("does not acknowledge a signed receipt after %s", async (_label, result) => {
    mocks.updateBySid.mockResolvedValueOnce(result);

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.updateBySid).toHaveBeenCalledWith(messageSid, "delivered", null);
  });

  it("acknowledges only an exactly persisted terminal receipt", async () => {
    const body = new URLSearchParams({
      MessageSid: messageSid,
      MessageStatus: "FAILED",
      ErrorCode: "30003",
    }).toString();

    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/xml");
    expect(await response.text()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
    expect(mocks.updateBySid).toHaveBeenCalledWith(messageSid, "failed", "30003");
  });

  it("validates and persists a signed review-notification correlation URL", async () => {
    const notificationId = "10100000-0000-4000-8000-000000000005";
    const callbackUrl =
      `https://nailiq.test/api/twilio/status?notification_id=${notificationId}`;

    const response = await POST(request(undefined, {}, callbackUrl));

    expect(response.status).toBe(200);
    expect(mocks.validate).toHaveBeenCalledWith(
      callbackUrl,
      expect.objectContaining({
        MessageSid: messageSid,
        MessageStatus: "delivered",
      }),
      "signed",
      "auth-token",
    );
    expect(mocks.updateBySid).toHaveBeenCalledWith(
      messageSid,
      "delivered",
      null,
      notificationId,
    );
  });

  it("rejects a signed malformed review-notification correlation id", async () => {
    const response = await POST(request(
      undefined,
      {},
      "https://nailiq.test/api/twilio/status?notification_id=not-a-uuid",
    ));

    expect(response.status).toBe(422);
    expect(mocks.updateBySid).not.toHaveBeenCalled();
  });

  it("acknowledges an exact terminal replay without requiring a second write", async () => {
    mocks.updateBySid.mockResolvedValueOnce({
      ok: true,
      code: "exact_replay",
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
  });

  it("acknowledges a conflicting terminal receipt only after durable capture", async () => {
    mocks.updateBySid.mockResolvedValueOnce({
      ok: true,
      code: "durable_conflict",
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
  });

  it("keeps an identical terminal callback replay idempotently acknowledged", async () => {
    const first = await POST(request());
    const replay = await POST(request());

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(mocks.updateBySid).toHaveBeenCalledTimes(2);
  });
});
