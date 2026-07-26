import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildHumanTransferTwiml,
  buildHumanTransferResultTwiml,
  callTransferSuppressReason,
  transferActiveTwilioCall,
} from "@/shared/lib/twilioCallTransfer";

function mockDb(platform: Record<string, unknown> | null) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: platform, error: null }),
  };
  return { from: () => chain } as never;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Twilio live call transfer", () => {
  it("builds a dial with answer-on-bridge and a signed-result callback", () => {
    const twiml = buildHumanTransferTwiml(
      "+16045550123",
      "https://www.nailiq.ca/api/twilio/voice/transfer-result?language=vi",
    );

    expect(twiml).toContain(
      '<Dial answerOnBridge="true" timeout="25" action="https://www.nailiq.ca/api/twilio/voice/transfer-result?language=vi" method="POST">',
    );
    expect(twiml).toContain("<Number>+16045550123</Number>");
    expect(twiml).not.toContain("<Say");
  });

  it("hangs up after a completed human call and speaks fallback only on no-answer", () => {
    expect(buildHumanTransferResultTwiml("completed", "vi")).toBe(
      "<Response><Hangup/></Response>",
    );
    const noAnswer = buildHumanTransferResultTwiml("no-answer", "vi");
    expect(noAnswer).toContain('<Say language="vi-VN">');
    expect(noAnswer).toContain("hiện chưa có người nghe máy");
    expect(noAnswer).toContain("<Hangup/>");
  });

  it("suppresses every outbound transfer outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(callTransferSuppressReason()).toBe("non_production_env");
  });

  it("rejects a transfer loop before making any network request", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await transferActiveTwilioCall({
      supabase: mockDb(null),
      callSid: `CA${"a".repeat(32)}`,
      destinationPhone: "+16045550123",
      calledPhone: "+16045550123",
      language: "en",
      statusCallbackUrl: "https://www.nailiq.ca/api/twilio/voice/transfer-result?language=en",
    });

    expect(result).toEqual({ ok: false, error: "transfer_loop" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("updates only the trusted active Call SID and sends server-built TwiML", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    const callSid = `CA${"b".repeat(32)}`;

    const result = await transferActiveTwilioCall({
      supabase: mockDb({
        twilio_account_sid: "AC_TEST_ACCOUNT",
        twilio_auth_token: "test-token",
        twilio_phone_number: "+16045550999",
      }),
      callSid,
      destinationPhone: "+16045550123",
      calledPhone: "+16045550888",
      language: "en",
      statusCallbackUrl: "https://www.nailiq.ca/api/twilio/voice/transfer-result?language=en",
    });

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain(`/Calls/${callSid}.json`);
    expect(init?.method).toBe("POST");
    const body = init?.body as URLSearchParams;
    expect(body.get("Twiml")).toContain("<Number>+16045550123</Number>");
    expect(body.get("Twiml")).toContain("transfer-result?language=en");
    expect(body.get("Twiml")).not.toContain("test-token");
  });
});
